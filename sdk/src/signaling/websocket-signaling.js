/**
 * @file websocket-signaling.js
 * @description WebSocket centralized signaling with auto-reconnect and heartbeat.
 * The server must implement: announce, signal relay, and optional ice-config push.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('WebSocketSignaling');

export class WebSocketSignaling extends EventBus {
  /**
   * @param {string} url — WebSocket signaling server URL
   */
  constructor(url) {
    super();
    if (!url) throw new TypeError('url is required');
    this._url = url;
    this._localId = null;
    /** @type {WebSocket|null} */
    this._ws = null;
    this._reconnectAttempts = 0;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._closed = false;
  }

  // ─── ISignaling contract ─────────────────────────────────────────────────────

  async init(localId) {
    if (!localId) throw new TypeError('localId is required');
    this._localId = localId;
    await this._connect();
  }

  async announce() {
    this._send({ type: 'announce', peerId: this._localId });
  }

  sendToPeer(peerId, msg) {
    this._send({ type: 'signal', target: peerId, from: this._localId, signal: msg });
  }

  close() {
    this._closed = true;
    clearInterval(this._heartbeatTimer);
    clearTimeout(this._reconnectTimer);
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    try { this._ws?.close(); } catch { /* ignore */ }
    this._ws = null;
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /** @private */
  _connect() {
    return new Promise((resolve, reject) => {
      let resolved = false;
      this._ws = new WebSocket(this._url);

      this._ws.onopen = () => {
        this._reconnectAttempts = 0;
        log.info(`Connected to signaling server ${this._url}`);
        this._startHeartbeat();
        this.emit('connected', {});
        resolved = true;
        resolve();
      };

      this._ws.onmessage = ({ data }) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        this._handleMessage(msg);
      };

      this._ws.onerror = (e) => {
        log.error('WebSocket signaling error', e);
        this.emit('error', { error: e });
        if (!resolved) { resolved = true; reject(e); }
      };

      this._ws.onclose = ({ code, reason }) => {
        log.info(`Signaling WS closed: ${code} ${reason}`);
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
        this.emit('disconnected', {});
        if (!this._closed) this._scheduleReconnect();
      };
    });
  }

  /** @private */
  _handleMessage(msg) {
    switch (msg.type) {
      case 'peer:announce':
        this.emit('peer:announce', { peerId: msg.peerId, cell: msg.cell });
        break;
      case 'signal':
        this.emit('signal', { from: msg.from, msg: msg.signal });
        break;
      case 'ice-config':
        this.emit('ice-config', { iceServers: msg.iceServers });
        break;
      case 'pong':
        break;
      default:
        log.debug('Unknown signaling message type', msg.type);
    }
  }

  /** @private */
  _startHeartbeat() {
    clearInterval(this._heartbeatTimer);
    const interval = config.get('signaling.heartbeatIntervalMs');
    this._heartbeatTimer = setInterval(() => {
      this._send({ type: 'ping' });
    }, interval);
  }

  /** @private */
  _scheduleReconnect() {
    const maxAttempts = config.get('transport.reconnectMaxAttempts');
    if (this._reconnectAttempts >= maxAttempts) {
      log.warn('Max signaling reconnect attempts reached');
      return;
    }
    const base = config.get('transport.reconnectBaseDelay');
    const maxDelay = config.get('transport.reconnectMaxDelay');
    const delay = Math.min(base * Math.pow(2, this._reconnectAttempts), maxDelay);
    this._reconnectAttempts++;
    log.info(`Reconnecting to signaling in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      if (!this._closed) this._connect().catch(() => {});
    }, delay);
  }

  /** @private */
  _send(obj) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }
}

export default WebSocketSignaling;
