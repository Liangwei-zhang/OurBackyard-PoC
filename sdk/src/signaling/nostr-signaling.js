/**
 * @file nostr-signaling.js
 * @description Nostr decentralized signaling with multi-relay parallel connection,
 * NIP-01 event building, Schnorr signing (secp256k1), H3 L7 cell channel scoping,
 * peer ID validation, and reconnect on relay disconnect.
 * Zero external dependencies beyond the secp256k1 helper loaded globally.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('NostrSignaling');

/** Minimum relay count to consider "connected" */
const MIN_RELAYS = 1;

/** Validate a peer ID to prevent injection attacks. Accepts hex strings and did:ob: DIDs */
function isValidPeerId(id) {
  if (typeof id !== 'string' || !id) return false;
  if (id.startsWith('did:ob:')) return /^did:ob:[0-9a-f]{64}$/.test(id);
  return /^[0-9a-f]{64}$/.test(id);
}

export class NostrSignaling extends EventBus {
  /**
   * @param {object} opts
   * @param {string[]} opts.relays       — list of relay URLs
   * @param {string}   [opts.cell]       — H3 cell index for geographic scoping (L7 ~5km²)
   * @param {Function} [opts.signer]     — async (eventJson: string) => hexSig (Schnorr)
   *                                       Required if you want signed events.
   * @param {string}   [opts.pubkey]     — hex public key matching signer
   */
  constructor(opts = {}) {
    super();
    if (!opts.relays?.length) throw new TypeError('At least one relay URL is required');
    this._relayUrls = opts.relays;
    this._cell = opts.cell ?? null;
    this._signer = opts.signer ?? null;
    this._pubkey = opts.pubkey ?? null;
    this._localId = null;
    /** @type {Map<string, WebSocket>} url → ws */
    this._sockets = new Map();
    /** @type {string|null} Nostr subscription ID */
    this._subId = null;
    this._closed = false;
  }

  // ─── ISignaling contract ─────────────────────────────────────────────────────

  async init(localId) {
    if (!localId) throw new TypeError('localId is required');
    this._localId = localId;
    this._subId = `ob-${Math.random().toString(36).slice(2, 10)}`;
    await this._connectRelays();
  }

  async announce() {
    const content = JSON.stringify({
      type: 'peer:announce',
      peerId: this._localId,
      cell: this._cell,
    });
    await this._publish({ kind: 20001, content, tags: this._cell ? [['h', this._cell]] : [] });
    log.info(`Announced as ${this._localId} cell=${this._cell}`);
  }

  sendToPeer(peerId, msg) {
    if (!isValidPeerId(peerId) && !peerId.startsWith('did:ob:')) {
      log.warn(`Dropping signal to invalid peerId: ${peerId}`);
      return;
    }
    const content = JSON.stringify({ type: 'signal', from: this._localId, to: peerId, msg });
    this._publish({ kind: 20002, content, tags: [['p', peerId.replace('did:ob:', '')]] }).catch(e => {
      log.error('sendToPeer publish failed', e);
    });
  }

  close() {
    this._closed = true;
    for (const ws of this._sockets.values()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this._sockets.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /** @private */
  async _connectRelays() {
    const results = await Promise.allSettled(
      this._relayUrls.map(url => this._openRelay(url)),
    );
    const connected = results.filter(r => r.status === 'fulfilled').length;
    if (connected < MIN_RELAYS) {
      throw new Error(`Failed to connect to any Nostr relay (tried ${this._relayUrls.length})`);
    }
    log.info(`Connected to ${connected}/${this._relayUrls.length} relays`);
    this.emit('connected', { connectedRelays: connected });
  }

  /** @private */
  _openRelay(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let resolved = false;

      ws.onopen = () => {
        this._sockets.set(url, ws);
        // Subscribe to signaling events directed at us or from our cell
        const filters = [
          { kinds: [20002], '#p': [this._localId?.replace('did:ob:', '') ?? ''] },
          { kinds: [20001], ...(this._cell ? { '#h': [this._cell] } : {}) },
        ];
        ws.send(JSON.stringify(['REQ', this._subId, ...filters]));
        resolved = true;
        resolve();
      };

      ws.onmessage = ({ data }) => {
        try {
          const parsed = JSON.parse(data);
          this._handleRelayMessage(parsed);
        } catch (e) {
          log.warn('Failed to parse relay message', e);
        }
      };

      ws.onerror = (e) => {
        log.error(`Relay ${url} error`, e);
        this.emit('error', { error: e });
        if (!resolved) { resolved = true; reject(e); }
      };

      ws.onclose = () => {
        this._sockets.delete(url);
        this.emit('disconnected', { relay: url });
        if (!this._closed) {
          const delay = config.get('transport.reconnectBaseDelay');
          setTimeout(() => {
            if (!this._closed) this._openRelay(url).catch(() => {});
          }, delay);
        }
      };
    });
  }

  /** @private */
  _handleRelayMessage(parsed) {
    if (!Array.isArray(parsed)) return;
    const [verb, , event] = parsed;
    if (verb !== 'EVENT' || !event?.content) return;

    let payload;
    try { payload = JSON.parse(event.content); } catch { return; }

    if (payload.type === 'peer:announce') {
      if (!isValidPeerId(payload.peerId) && !payload.peerId?.startsWith('did:ob:')) return;
      if (payload.peerId === this._localId) return; // ignore self
      this.emit('peer:announce', { peerId: payload.peerId, cell: payload.cell });

    } else if (payload.type === 'signal') {
      if (payload.to !== this._localId) return;
      if (!payload.from || (!isValidPeerId(payload.from) && !payload.from.startsWith('did:ob:'))) return;
      this.emit('signal', { from: payload.from, msg: payload.msg });
    }
  }

  /** @private */
  async _publish({ kind, content, tags = [] }) {
    const event = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
      pubkey: this._pubkey ?? '0'.repeat(64),
    };
    event.id = await this._eventId(event);
    if (this._signer) {
      event.sig = await this._signer(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]));
    } else {
      event.sig = '0'.repeat(128);
    }
    const msg = JSON.stringify(['EVENT', event]);
    let sent = 0;
    for (const ws of this._sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        sent++;
      }
    }
    if (sent === 0) log.warn('No open relay connections to publish to');
  }

  /** @private */
  async _eventId(event) {
    const serialized = JSON.stringify([
      0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
    ]);
    const enc = new TextEncoder().encode(serialized);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export default NostrSignaling;
