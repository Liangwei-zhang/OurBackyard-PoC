/**
 * NostrSignaling — Decentralised WebRTC signaling over public Nostr relays.
 *
 * Refactored from native/communication/nostr-signaling.js to:
 *   - Implement ISignaling interface (EventBus instead of callbacks)
 *   - Keep the L7 H3 cell channel logic
 *   - Keep multi-relay parallel connection
 *   - Keep NIP-01 event building + Schnorr signing
 *   - Accept optional secp256k1 module injection instead of global detection
 *   - No hardcoded relay list (passed via config, sensible defaults provided)
 *
 * Events emitted:
 *   'signal'        (fromPeerId, signal)
 *   'peer:announce' (peerId, meta)
 *   'status'        ('online'|'offline')
 */

import { ISignaling } from './signaling-interface.js';

/** Peer ID must be alphanumeric + underscore/dash, 1-50 chars */
const PEER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,50}$/;

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  // nostr.wine removed — rejects ALL writes ("restricted: sign up"), causes noisy logs
  // and contributes to damus rate-limit budget since we broadcast to all relays at once.
  'wss://relay.snort.social',
  'wss://nostr.oxtr.dev',
  'wss://relay.primal.net',
  // Removed: 'wss://nos.lol'              — requires 28-bit PoW (NIP-13), always rejects us
  // Removed: 'wss://nostr-pub.wellorder.net' — blocks all events as "spam"
];

// Custom Nostr kinds
// KIND_SIGNAL  : ephemeral (25001) — real-time only, never stored by relays
// KIND_ANNOUNCE: replaceable (10751) — stored & returned on query, one per pubkey per kind
//   WHY: ephemeral (20000-29999) events are NOT stored by relays. Two devices booting near
//   the same time miss each other's initial announce and rely solely on the 15 s heartbeat.
//   Replaceable stored events let a new joiner immediately fetch ALL active peers via 'since'.
const KIND_SIGNAL   = 25001;
const KIND_ANNOUNCE = 10751;

export class NostrSignaling extends ISignaling {
  /**
   * @param {object} opts
   * @param {string}   opts.peerId          — Local peer identifier
   * @param {string}   opts.h3Cell          — H3 L9 cell hex (geographic channel key)
   * @param {string[]} [opts.relays]        — Relay URLs (defaults to public list)
   * @param {object}   [opts.secp256k1]     — Injected secp256k1 module ({ getPublicKey, schnorrSign })
   * @param {number}   [opts.bootTimeoutMs=4000]
   * @param {number}   [opts.relayTimeoutMs=6000]
   * @param {number}   [opts.reconnectMs=3000]
   * @param {number}   [opts.announceIntervalMs=45000]
   */
  constructor({ peerId, h3Cell, relays, secp256k1, bootTimeoutMs = 4000, relayTimeoutMs = 6000, reconnectMs = 3000, announceIntervalMs = 60000 }) {
    super();
    this.peerId         = peerId;
    this.h3Cell         = h3Cell;
    this.channelCell    = NostrSignaling._toL7(h3Cell);
    this._relayUrls     = relays ?? DEFAULT_RELAYS;
    this._secp256k1     = secp256k1 ?? null;
    this._bootTimeoutMs = bootTimeoutMs;
    this._relayTimeoutMs = relayTimeoutMs;
    this._reconnectMs   = reconnectMs;
    this._announceIntervalMs = announceIntervalMs;

    /** @type {Map<string, WebSocket>} url → socket */
    this._relays        = new Map();
    /** @type {Set<string>} */
    this._connected     = new Set();
    this._subId         = this._randomHex(16);
    this._pubkey        = null;
    this._privkey       = null;
    /** @type {object[]} events queued before first relay connects */
    this._pendingQueue  = [];
    this._announceTimer  = null;
    this._lastAnnounceMeta = { h3Cell };
    /** @type {Set<string>} Dedup set for received Nostr event IDs (multi-relay dedup) */
    this._seenEventIds  = new Set();
    /**
     * Peer-level announce dedup: peerId → last emit timestamp.
     * Multiple relays deliver the same logical announce with DIFFERENT Nostr event IDs
     * (each relay connection triggers _republishPresenceToRelay with ts: Date.now()).
     * Event-level dedup alone can't catch these; we suppress re-emits within 15 s.
     */
    this._seenPeerAnnounces = new Map();
    /** @type {Map<string, object[]>} ICE candidate batch buffer: targetPeerId → candidates[] */
    this._iceBatch      = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} flush timers */
    this._iceFlushTimers = new Map();

    console.log(`[NostrSignaling] L9 cell: ${h3Cell} → L7 channel: ${this.channelCell}`);
  }

  // ─────────────────────────── ISignaling API ───────────────────────────

  async connect() {
    await this._initKeys();

    await new Promise((resolve) => {
      let settled = 0;
      const total = this._relayUrls.length;
      const fastResolve = () => { if (this._connected.size >= 1) resolve(); };
      const onDone = () => {
        settled++;
        fastResolve();
        if (settled >= total) resolve();
      };
      this._relayUrls.forEach(url => this._connectRelay(url).then(onDone).catch(onDone));
      const boot = setTimeout(resolve, this._bootTimeoutMs);
      boot?.unref?.();
    });

    const online = this._connected.size > 0;
    if (!online) console.warn('[NostrSignaling] No relays connected — falling back to LAN only');
    else         console.log(`[NostrSignaling] Connected to ${this._connected.size} relays`);

    this._startPresenceHeartbeat();
    // Announce immediately so peers discover us right away (don't wait up to 60s for the timer)
    if (online) this.announce(this._lastAnnounceMeta).catch(() => {});
    this.emit('status', online ? 'online' : 'offline');
  }

  async disconnect() {
    this._stopPresenceHeartbeat();
    for (const [url, ws] of this._relays) {
      try { ws.close(); } catch {}
      this._relays.delete(url);
      this._connected.delete(url);
    }
    this.emit('status', 'offline');
  }

  async sendSignal(targetPeerId, signal) {
    // ICE candidates: buffer and batch to reduce Nostr relay event counts.
    // 3 peers × ~10 ICE candidates × 4 relays = ~120 events/s → rate-limited immediately.
    // Batching: collect all ICE candidates for 300ms, then send as one event to ONE relay.
    if (signal?.type === 'ice-candidate') {
      if (!this._iceBatch.has(targetPeerId)) {
        this._iceBatch.set(targetPeerId, []);
      }
      this._iceBatch.get(targetPeerId).push(signal.candidate);

      // Schedule flush if not already pending
      if (!this._iceFlushTimers.has(targetPeerId)) {
        const t = setTimeout(() => this._flushIceBatch(targetPeerId), 300);
        t?.unref?.();
        this._iceFlushTimers.set(targetPeerId, t);
      }
      return;
    }

    console.log(`[NostrSignaling] → signal '${signal?.type}' to ${targetPeerId.slice(0, 12)}`);
    let event;
    try {
      event = await this._buildEvent(
        KIND_SIGNAL,
        JSON.stringify(signal),
        [
          ['t',      this.channelCell],
          ['peer',   this.peerId],
          ['target', targetPeerId],
        ]
      );
    } catch (e) {
      this.emit('error', e);
      return;
    }
    // offer/answer: send to ONE relay (receiver subscribes to all — one delivery is enough).
    // This halves the relay event rate vs broadcasting, reducing rate-limit risk.
    this._publishToOne(event);
  }

  /** Flush buffered ICE candidates for a peer as a single batched event */
  async _flushIceBatch(targetPeerId) {
    this._iceFlushTimers.delete(targetPeerId);
    const candidates = this._iceBatch.get(targetPeerId) || [];
    this._iceBatch.delete(targetPeerId);
    if (candidates.length === 0) return;

    console.log(`[NostrSignaling] → ice-candidates-batch (${candidates.length}) to ${targetPeerId.slice(0, 12)}`);
    let event;
    try {
      event = await this._buildEvent(
        KIND_SIGNAL,
        JSON.stringify({ type: 'ice-candidates-batch', candidates }),
        [
          ['t',      this.channelCell],
          ['peer',   this.peerId],
          ['target', targetPeerId],
        ]
      );
    } catch (e) {
      this.emit('error', e);
      return;
    }
    // ICE batch → single relay is sufficient (peer subscribes to all relays)
    this._publishToOne(event);
  }

  async announce(meta = {}) {
    this._lastAnnounceMeta = { ...this._lastAnnounceMeta, ...meta };
    let event;
    try {
      event = await this._buildEvent(
        KIND_ANNOUNCE,
        JSON.stringify({ peerId: this.peerId, ts: Date.now(), ...this._lastAnnounceMeta }),
        [
          ['t',    this.channelCell],
          ['peer', this.peerId],
        ]
      );
    } catch (e) {
      this.emit('error', e);
      return;
    }
    this._publish(event);
  }

  get isOnline() { return this._connected.size > 0; }

  // ─────────────────────────── H3 cell helpers ───────────────────────────

  /**
   * Convert H3 L9 cell to L7 parent via bit manipulation (no h3-js needed).
   * L7 covers ~5 km² — ensures neighbours on different L9 cells share one channel.
   * @param {string} h3CellHex
   * @returns {string}
   */
  static _toL7(h3CellHex) {
    try {
      if (!h3CellHex || !/^[0-9a-fA-F]{15}$/.test(String(h3CellHex).replace(/^0+/, '').padStart(15, '0'))) {
        return h3CellHex;
      }
      const normalized = String(h3CellHex).padStart(15, '0');
      const cell = BigInt('0x' + normalized);
      // Mask digits 7-14 to 7 (0b111)
      let digitMask = 0n;
      for (let d = 7; d < 15; d++) {
        const shift = BigInt(44 - d * 3);
        digitMask |= (7n << shift);
      }
      // Set resolution field [55:52] to 7
      const resMask = 0xFn << 52n;
      const l7 = (cell & ~resMask & ~digitMask) | (7n << 52n) | digitMask;
      return l7.toString(16).padStart(15, '0');
    } catch {
      return h3CellHex;
    }
  }

  // ─────────────────────────── Relay management ───────────────────────────

  _connectRelay(url) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), this._relayTimeoutMs);
      timeout?.unref?.();

      try {
        const ws = new WebSocket(url);

        ws.onopen = () => {
          clearTimeout(timeout);
          this._relays.set(url, ws);
          this._connected.add(url);
          this._subscribe(ws);
          // Flush queued events
          for (const ev of this._pendingQueue) this._publishToRelay(ws, ev);
          this._pendingQueue = [];
          this._republishPresenceToRelay(ws);
          console.log(`[NostrSignaling] Connected: ${url}`);
          resolve(ws);
        };

        ws.onmessage = (e) => this._handleRelayMsg(url, e.data);

        ws.onclose = () => {
          this._relays.delete(url);
          this._connected.delete(url);
          if (this._connected.size === 0) {
            this._stopPresenceHeartbeat();
            this.emit('status', 'offline');
          }
          // Reconnect with backoff
          const rTimer = setTimeout(() => this._connectRelay(url), this._reconnectMs);
          rTimer?.unref?.();
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(null);
        };
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  _subscribe(ws) {
    const filter = {
      kinds: [KIND_SIGNAL, KIND_ANNOUNCE],
      '#t':  [this.channelCell],   // #t (topic) replaces #h — widely supported
      since: Math.floor(Date.now() / 1000) - 1800, // 30 min: fetch stored replaceable announces
    };
    ws.send(JSON.stringify(['REQ', this._subId, filter]));
    console.log(`[NostrSignaling] Subscribed channel=${this.channelCell} on ${ws.url || 'relay'}`);
  }

  // ─────────────────────────── Incoming message handling ───────────────────────────

  _handleRelayMsg(url, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Relay diagnostic messages — critical for debugging relay compatibility
    if (msg[0] === 'NOTICE') {
      console.log(`[NostrSignaling] NOTICE from ${url}:`, msg[1]);
      return;
    }
    if (msg[0] === 'OK') {
      if (msg[2] === false) console.warn(`[NostrSignaling] Event REJECTED by ${url}:`, msg[3]);
      return;
    }
    if (msg[0] === 'EOSE') {
      console.log(`[NostrSignaling] EOSE from ${url} — stored history delivered`);
      return;
    }

    if (msg[0] !== 'EVENT') return;

    const event = msg[2];
    if (!event || typeof event !== 'object' || !event.kind || typeof event.content !== 'string') return;
    if (event.content.length > 65536) return; // 64 KB sanity limit
    if (event.pubkey === this._pubkey) return; // ignore own events

    // Deduplicate events received from multiple relays
    if (event.id) {
      if (this._seenEventIds.has(event.id)) return;
      this._seenEventIds.add(event.id);
      if (this._seenEventIds.size > 200) {
        this._seenEventIds.delete(this._seenEventIds.values().next().value);
      }
    }

    const senderPeerId = this._getTag(event, 'peer');
    const targetPeerId = this._getTag(event, 'target');

    // Validate peerId to prevent injection via crafted Nostr events
    if (!senderPeerId || !PEER_ID_PATTERN.test(senderPeerId)) return;

    if (event.kind === KIND_ANNOUNCE) {
      try {
        const meta = JSON.parse(event.content);
        // Peer-level dedup: same peer announced by 4 relays → emit only once per 15 s.
        const now = Date.now();
        const lastSeen = this._seenPeerAnnounces.get(senderPeerId) || 0;
        if (now - lastSeen < 15000) {
          // Still emit a log at debug level so relay activity is visible, but suppress the
          // peer:announce event that would trigger another WebRTC connect + relay-sync timer.
          return;
        }
        this._seenPeerAnnounces.set(senderPeerId, now);
        // Evict stale entries to prevent unbounded growth in long-running nodes
        if (this._seenPeerAnnounces.size > 1000) {
          for (const [k, v] of this._seenPeerAnnounces) {
            if (now - v > 120000) this._seenPeerAnnounces.delete(k);
          }
        }
        console.log(`[NostrSignaling] Peer announce: ${senderPeerId} via ${url}`);
        this.emit('peer:announce', senderPeerId, meta);
      } catch {}
      return;
    }

    if (event.kind === KIND_SIGNAL) {
      // Only process signals directed at us (or broadcast)
      if (targetPeerId && targetPeerId !== this.peerId) return;
      try {
        const signal = JSON.parse(event.content);
        console.log(`[NostrSignaling] ← signal '${signal?.type}' from ${senderPeerId.slice(0, 12)} via ${url}`);
        this.emit('signal', senderPeerId, signal);
      } catch (e) {
        console.error('[NostrSignaling] Signal parse error:', e);
      }
    }
  }

  // ─────────────────────────── Publish ───────────────────────────

  _publish(event) {
    const msg = JSON.stringify(['EVENT', event]);
    let sent = 0;
    for (const ws of this._relays.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        sent++;
      }
    }
    if (sent === 0) this._pendingQueue.push(event);
  }

  /**
   * Publish to exactly ONE connected relay (for directed signals that don't need broadcast).
   * Falls back to all-relays publish if no connected relay exists.
   */
  _publishToOne(event) {
    // Pick a random connected relay to distribute load
    const open = [];
    for (const ws of this._relays.values()) {
      if (ws.readyState === WebSocket.OPEN) open.push(ws);
    }
    if (open.length === 0) { this._pendingQueue.push(event); return; }
    const ws = open[Math.floor(Math.random() * open.length)];
    ws.send(JSON.stringify(['EVENT', event]));
  }

  _publishToRelay(ws, event) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['EVENT', event]));
  }

  _startPresenceHeartbeat() {
    if (this._announceTimer || this._announceIntervalMs <= 0) return;
    this._announceTimer = setInterval(() => {
      if (this._connected.size === 0) return;
      this.announce(this._lastAnnounceMeta).catch(() => {});
    }, this._announceIntervalMs);
    // unref so this timer doesn't prevent process exit (e.g. in tests / clean shutdown)
    this._announceTimer?.unref?.();
  }

  _stopPresenceHeartbeat() {
    if (!this._announceTimer) return;
    clearInterval(this._announceTimer);
    this._announceTimer = null;
  }

  _republishPresenceToRelay(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._pubkey) return;
    this._buildEvent(
      KIND_ANNOUNCE,
      JSON.stringify({ peerId: this.peerId, ts: Date.now(), ...this._lastAnnounceMeta }),
      [
        ['t', this.channelCell],   // must match subscription filter '#t'
        ['peer', this.peerId],
      ],
    ).then(event => {
      this._publishToRelay(ws, event);
    }).catch(() => {});
  }

  // ─────────────────────────── NIP-01 event building ───────────────────────────

  async _buildEvent(kind, content, tags) {
    const event = {
      pubkey:     this._pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content,
    };
    event.id  = await this._eventId(event);
    event.sig = await this._sign(event.id);
    return event;
  }

  async _eventId(event) {
    const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ─────────────────────────── Key management ───────────────────────────

  async _initKeys() {
    // Deterministic private key: SHA-256("nostr-priv:" + peerId)
    const seed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('nostr-priv:' + this.peerId));
    const seedHex = Array.from(new Uint8Array(seed)).map(b => b.toString(16).padStart(2, '0')).join('');

    const lib = this._secp256k1 ?? (typeof secp256k1 !== 'undefined' ? secp256k1 : null);
    if (lib?.getPublicKey) {
      this._privkey = seedHex;
      this._pubkey  = lib.getPublicKey(seedHex);
      console.log('[NostrSignaling] secp256k1 keys ready, pubkey:', this._pubkey.slice(0, 16) + '...');
    } else {
      console.warn('[NostrSignaling] secp256k1 not loaded — using mock signatures, relay may reject events');
      this._privkey = null;
      this._pubkey  = seedHex;
    }
  }

  async _sign(id) {
    const lib = this._secp256k1 ?? (typeof secp256k1 !== 'undefined' ? secp256k1 : null);
    if (this._privkey && lib?.schnorrSign) {
      return lib.schnorrSign(id, this._privkey);
    }
    throw new Error('[NostrSignaling] secp256k1 unavailable — cannot produce valid Schnorr signatures; install the secp256k1 library');
  }

  // ─────────────────────────── Helpers ───────────────────────────

  _getTag(event, name) {
    return event.tags?.find(t => t[0] === name)?.[1];
  }

  _randomHex(len) {
    return Array.from(crypto.getRandomValues(new Uint8Array(len)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
