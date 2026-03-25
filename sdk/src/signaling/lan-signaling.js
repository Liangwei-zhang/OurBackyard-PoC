/**
 * @file lan-signaling.js
 * @description LAN discovery via BroadcastChannel API for same-network peers.
 * Works without any server — perfect for local network P2P.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('LANSignaling');

/** Channel name prefix — scoped to prevent cross-app interference */
const CHANNEL_PREFIX = 'ob:signaling:';

export class LANSignaling extends EventBus {
  /**
   * @param {object} [opts]
   * @param {string} [opts.channel='default'] — logical channel name (e.g., H3 cell)
   */
  constructor(opts = {}) {
    super();
    this._channelName = CHANNEL_PREFIX + (opts.channel ?? 'default');
    this._localId = null;
    /** @type {BroadcastChannel|null} */
    this._bc = null;
    this._announceTimer = null;
  }

  // ─── ISignaling contract ─────────────────────────────────────────────────────

  async init(localId) {
    if (!localId) throw new TypeError('localId is required');
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel is not supported in this environment');
    }
    this._localId = localId;
    this._bc = new BroadcastChannel(this._channelName);
    this._bc.onmessage = ({ data }) => this._handleMessage(data);
    log.info(`LAN signaling on channel "${this._channelName}"`);
    this.emit('connected', {});
  }

  async announce() {
    this._broadcast({ type: 'peer:announce', peerId: this._localId });
    // Repeat announces on an interval so late-joining peers discover us
    const interval = config.get('signaling.announceIntervalMs');
    this._announceTimer = setInterval(() => {
      this._broadcast({ type: 'peer:announce', peerId: this._localId });
    }, interval);
  }

  sendToPeer(peerId, msg) {
    this._broadcast({ type: 'signal', from: this._localId, to: peerId, msg });
  }

  close() {
    clearInterval(this._announceTimer);
    this._announceTimer = null;
    try { this._bc?.close(); } catch { /* ignore */ }
    this._bc = null;
    this.emit('disconnected', {});
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /** @private */
  _broadcast(data) {
    if (!this._bc) { log.warn('BroadcastChannel not open'); return; }
    this._bc.postMessage(data);
  }

  /** @private */
  _handleMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'peer:announce') {
      if (data.peerId === this._localId) return; // ignore self
      this.emit('peer:announce', { peerId: data.peerId });
    } else if (data.type === 'signal') {
      if (data.to !== this._localId) return;
      this.emit('signal', { from: data.from, msg: data.msg });
    }
  }
}

export default LANSignaling;
