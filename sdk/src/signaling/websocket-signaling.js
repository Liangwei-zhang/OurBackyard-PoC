/**
 * WebSocketSignaling — Lightweight centralised signaling over your own WebSocket server.
 *
 * Use this alongside a simple signaling server for production deployments.
 * The server only needs to relay JSON messages — no P2P logic required.
 *
 * Protocol (JSON over WS):
 *   Client → Server:
 *     { type: 'announce', peerId, roomId?, meta? }
 *     { type: 'signal',   target, signal, from }
 *
 *   Server → Client:
 *     { type: 'signal',      from, signal }      — relayed SDP/ICE
 *     { type: 'announce',    peerId, meta }       — peer discovery
 *     { type: 'peer-joined', peerId }             — presence
 *     { type: 'peer-left',   peerId }             — presence
 *     { type: 'ice-config',  config }             — TURN credentials from server
 *
 * Events emitted (in addition to ISignaling events):
 *   'ice-config' ({ iceServers, ttl, expiresAt })
 */

import { ISignaling } from './signaling-interface.js';

export class WebSocketSignaling extends ISignaling {
  /**
   * @param {object} opts
   * @param {string}  opts.url           — WebSocket server URL
   * @param {string}  opts.peerId        — Local peer identifier
   * @param {string}  [opts.roomId]      — Optional room / channel to join
   * @param {number}  [opts.reconnectMs=3000]
   */
  constructor({ url, peerId, roomId, reconnectMs = 3000 }) {
    super();
    this._url         = url;
    this.peerId       = peerId;
    this._roomId      = roomId;
    this._reconnectMs = reconnectMs;

    /** @type {WebSocket|null} */
    this._ws          = null;
    this._online      = false;
    this._intentionalClose = false;
  }

  // ─────────────────────────── ISignaling API ───────────────────────────

  async connect() {
    this._intentionalClose = false;
    return this._connect();
  }

  async disconnect() {
    this._intentionalClose = true;
    this._ws?.close();
    this._ws     = null;
    this._online = false;
    this.emit('status', 'offline');
  }

  async sendSignal(targetPeerId, signal) {
    this._send({ type: 'signal', target: targetPeerId, from: this.peerId, signal });
  }

  async announce(meta = {}) {
    this._send({ type: 'announce', peerId: this.peerId, roomId: this._roomId, meta });
  }

  get isOnline() { return this._online; }

  // ─────────────────────────── Internal ───────────────────────────

  _connect() {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(this._url);
        this._ws = ws;

        ws.onopen = () => {
          this._online = true;
          this.emit('status', 'online');
          // Announce ourselves as soon as the socket is open
          this.announce().catch(() => {});
          resolve();
        };

        ws.onmessage = (e) => this._handleMessage(e.data);

        ws.onclose = () => {
          this._online = false;
          this.emit('status', 'offline');
          if (!this._intentionalClose) {
            setTimeout(() => this._connect(), this._reconnectMs);
          }
        };

        ws.onerror = () => {
          resolve(); // resolve anyway so callers don't hang
        };
      } catch (e) {
        console.warn('[WebSocketSignaling] connect error:', e);
        resolve();
      }
    });
  }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'signal':
        if (msg.from && msg.signal) this.emit('signal', msg.from, msg.signal);
        break;

      case 'announce':
        if (msg.peerId && msg.peerId !== this.peerId) {
          this.emit('peer:announce', msg.peerId, msg.meta ?? {});
        }
        break;

      case 'peer-joined':
        if (msg.peerId && msg.peerId !== this.peerId) {
          this.emit('peer:announce', msg.peerId, {});
        }
        break;

      case 'peer-left':
        // Informational — consumers can listen for this raw event if needed
        this.emit('peer:left', msg.peerId);
        break;

      case 'ice-config':
        // Server pushed TURN credentials
        if (msg.config) this.emit('ice-config', msg.config);
        break;
    }
  }

  _send(obj) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify(obj)); } catch {}
    }
  }
}
