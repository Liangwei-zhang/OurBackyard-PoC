/**
 * @file websocket-transport.js
 * @description WebSocket direct transport — fallback channel when WebRTC is unavailable.
 * Maintains one WebSocket per peer. Not suitable for browser-to-browser without a relay.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import config from '../config.js';
import { Logger } from '../logger.js';

const log = new Logger('WebSocketTransport');

export class WebSocketTransport extends EventBus {
  constructor() {
    super();
    /** @type {Map<string, { ws: WebSocket, reconnectAttempts: number, reconnectTimer: number|null }>} */
    this._peers = new Map();
  }

  /**
   * Open a WebSocket to a URL and associate it with a peer ID.
   * @param {string} peerId
   * @param {string} url — WebSocket URL for that peer
   * @returns {Promise<void>}
   */
  async connect(peerId, url) {
    if (!peerId) throw new TypeError('peerId is required');
    if (!url) throw new TypeError('url is required');
    if (this._peers.has(peerId)) return;
    return this._openSocket(peerId, url);
  }

  /** @param {string} peerId @param {string|ArrayBuffer} data @returns {boolean} */
  send(peerId, data) {
    const entry = this._peers.get(peerId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) return false;
    try {
      entry.ws.send(data);
      return true;
    } catch (e) {
      log.error(`send error to ${peerId}`, e);
      return false;
    }
  }

  /** @param {string|ArrayBuffer} data */
  broadcast(data) {
    for (const peerId of this._peers.keys()) {
      this.send(peerId, data);
    }
  }

  /** @param {string} peerId */
  disconnect(peerId) {
    const entry = this._peers.get(peerId);
    if (!entry) return;
    if (entry.reconnectTimer !== null) clearTimeout(entry.reconnectTimer);
    try { entry.ws.close(); } catch { /* ignore */ }
    this._peers.delete(peerId);
    this.emit('close', { peerId, reason: 'local disconnect' });
  }

  close() {
    for (const peerId of [...this._peers.keys()]) this.disconnect(peerId);
  }

  /** @returns {string[]} */
  peers() { return [...this._peers.keys()]; }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** @private */
  _openSocket(peerId, url) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const ws = new WebSocket(url);
      const entry = { ws, url, reconnectAttempts: 0, reconnectTimer: null };
      this._peers.set(peerId, entry);

      ws.onopen = () => {
        entry.reconnectAttempts = 0;
        log.info(`WebSocket open to ${peerId}`);
        this.emit('open', { peerId });
        if (!resolved) { resolved = true; resolve(); }
      };

      ws.onmessage = ({ data }) => {
        this.emit('message', { peerId, data });
      };

      ws.onerror = (e) => {
        log.error(`WebSocket error for ${peerId}`, e);
        this.emit('error', { peerId, error: e });
        if (!resolved) { resolved = true; reject(e); }
      };

      ws.onclose = ({ code, reason }) => {
        log.info(`WebSocket closed for ${peerId}: ${code} ${reason}`);
        this.emit('close', { peerId, reason });
        if (!resolved) { resolved = true; reject(new Error(`WebSocket closed before open: ${code} ${reason}`)); }
        if (!this._peers.has(peerId)) return;
        this._scheduleReconnect(peerId, url);
      };
    });
  }

  /** @private */
  _scheduleReconnect(peerId, url) {
    const entry = this._peers.get(peerId);
    if (!entry || entry.reconnectTimer !== null) return;

    const maxAttempts = config.get('transport.reconnectMaxAttempts');
    if (entry.reconnectAttempts >= maxAttempts) {
      log.warn(`Max WS reconnect attempts for ${peerId}`);
      this._peers.delete(peerId);
      return;
    }

    const base = config.get('transport.reconnectBaseDelay');
    const maxDelay = config.get('transport.reconnectMaxDelay');
    const delay = Math.min(base * Math.pow(2, entry.reconnectAttempts), maxDelay);
    entry.reconnectAttempts++;

    log.info(`Reconnecting WS to ${peerId} in ${delay}ms`);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (this._peers.has(peerId)) this._openSocket(peerId, url).catch(() => {});
    }, delay);
  }
}

export default WebSocketTransport;
