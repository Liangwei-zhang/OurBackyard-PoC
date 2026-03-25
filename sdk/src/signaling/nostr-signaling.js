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

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nostr.wine',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr.oxtr.dev',
  'wss://relay.primal.net',
  'wss://nostr-pub.wellorder.net',
];

// Custom Nostr kinds — high numbers avoid polluting public content streams
const KIND_SIGNAL   = 25001;
const KIND_ANNOUNCE = 25002;

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
   */
  constructor({ peerId, h3Cell, relays, secp256k1, bootTimeoutMs = 4000, relayTimeoutMs = 6000, reconnectMs = 3000 }) {
    super();
    this.peerId         = peerId;
    this.h3Cell         = h3Cell;
    this.channelCell    = NostrSignaling._toL7(h3Cell);
    this._relayUrls     = relays ?? DEFAULT_RELAYS;
    this._secp256k1     = secp256k1 ?? null;
    this._bootTimeoutMs = bootTimeoutMs;
    this._relayTimeoutMs = relayTimeoutMs;
    this._reconnectMs   = reconnectMs;

    /** @type {Map<string, WebSocket>} url → socket */
    this._relays        = new Map();
    /** @type {Set<string>} */
    this._connected     = new Set();
    this._subId         = this._randomHex(16);
    this._pubkey        = null;
    this._privkey       = null;
    /** @type {object[]} events queued before first relay connects */
    this._pendingQueue  = [];

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
      setTimeout(resolve, this._bootTimeoutMs);
    });

    const online = this._connected.size > 0;
    if (!online) console.warn('[NostrSignaling] No relays connected — falling back to LAN only');
    else         console.log(`[NostrSignaling] Connected to ${this._connected.size} relays`);

    this.emit('status', online ? 'online' : 'offline');
  }

  async disconnect() {
    for (const [url, ws] of this._relays) {
      try { ws.close(); } catch {}
      this._relays.delete(url);
      this._connected.delete(url);
    }
    this.emit('status', 'offline');
  }

  async sendSignal(targetPeerId, signal) {
    const event = await this._buildEvent(
      KIND_SIGNAL,
      JSON.stringify(signal),
      [
        ['h',      this.channelCell],
        ['peer',   this.peerId],
        ['target', targetPeerId],
      ]
    );
    this._publish(event);
  }

  async announce(meta = {}) {
    const event = await this._buildEvent(
      KIND_ANNOUNCE,
      JSON.stringify({ peerId: this.peerId, ts: Date.now(), ...meta }),
      [
        ['h',    this.channelCell],
        ['peer', this.peerId],
      ]
    );
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
          console.log(`[NostrSignaling] Connected: ${url}`);
          resolve(ws);
        };

        ws.onmessage = (e) => this._handleRelayMsg(url, e.data);

        ws.onclose = () => {
          this._relays.delete(url);
          this._connected.delete(url);
          if (this._connected.size === 0) this.emit('status', 'offline');
          // Reconnect with backoff
          setTimeout(() => this._connectRelay(url), this._reconnectMs);
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
      '#h':  [this.channelCell],
      since: Math.floor(Date.now() / 1000) - 300,
    };
    ws.send(JSON.stringify(['REQ', this._subId, filter]));
  }

  // ─────────────────────────── Incoming message handling ───────────────────────────

  _handleRelayMsg(url, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg[0] !== 'EVENT') return;

    const event = msg[2];
    if (!event || typeof event !== 'object' || !event.kind || typeof event.content !== 'string') return;
    if (event.content.length > 65536) return; // 64 KB sanity limit
    if (event.pubkey === this._pubkey) return; // ignore own events

    const senderPeerId = this._getTag(event, 'peer');
    const targetPeerId = this._getTag(event, 'target');

    // Validate peerId to prevent injection via crafted Nostr events
    if (!senderPeerId || !/^[a-zA-Z0-9_-]{1,50}$/.test(senderPeerId)) return;

    if (event.kind === KIND_ANNOUNCE) {
      try {
        const meta = JSON.parse(event.content);
        this.emit('peer:announce', senderPeerId, meta);
      } catch {}
      return;
    }

    if (event.kind === KIND_SIGNAL) {
      // Only process signals directed at us (or broadcast)
      if (targetPeerId && targetPeerId !== this.peerId) return;
      try {
        const signal = JSON.parse(event.content);
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

  _publishToRelay(ws, event) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['EVENT', event]));
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
    // Fallback mock signature (64 bytes = 128 hex chars)
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id + this.peerId));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('') + '0'.repeat(64);
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
