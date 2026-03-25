/**
 * MessageRouter — Typed message routing with built-in deduplication.
 *
 * Extracted from p2p-mesh.js _onData() switch statement.
 * Sits above WebRTCTransport and routes JSON messages to registered handlers.
 * Binary frames (ArrayBuffer) are passed through as type 'binary'.
 *
 * Features:
 *   - Type-based handler registration
 *   - Message deduplication via LRU seen-set (1000 entries)
 *   - Transparent send / broadcast helpers
 */

import { EventBus } from '../event-bus.js';

// Maximum number of message IDs to remember for deduplication
const DEDUP_LIMIT = 1000;

export class MessageRouter extends EventBus {
  /**
   * @param {object} opts
   * @param {import('../transport/webrtc-transport.js').WebRTCTransport} opts.transport
   */
  constructor({ transport }) {
    super();
    this._transport = transport;
    /** @type {Map<string, Function>} msgType → handler */
    this._handlers  = new Map();
    /** @type {string[]} LRU queue of seen message IDs */
    this._seen      = [];

    // Wire up transport data events
    this._transport.on('data', (peerId, data) => this._onData(peerId, data));
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Register a handler for a message type.
   * @param {string}   type
   * @param {Function} handler  (fromPeerId, payload, rawMsg) => void
   * @returns {this}
   */
  handle(type, handler) {
    this._handlers.set(type, handler);
    return this;
  }

  /**
   * Send a typed JSON message to a single peer.
   * @param {string} peerId
   * @param {string} type
   * @param {object} [payload]
   * @returns {boolean}
   */
  send(peerId, type, payload = {}) {
    return this._transport.send(peerId, JSON.stringify({ type, ...payload }));
  }

  /**
   * Broadcast a typed JSON message to all connected peers.
   * @param {string} type
   * @param {object} [payload]
   * @param {string} [excludePeerId]
   */
  broadcast(type, payload = {}, excludePeerId) {
    this._transport.broadcast(JSON.stringify({ type, ...payload }), excludePeerId);
  }

  // ─────────────────────────── Internal ───────────────────────────

  _onData(fromPeerId, data) {
    // Binary frames bypass JSON routing
    if (data instanceof ArrayBuffer) {
      const handler = this._handlers.get('binary');
      if (handler) handler(fromPeerId, data);
      return;
    }

    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // Deduplication by optional msg.id
    if (msg.id) {
      if (this._seen.includes(msg.id)) return;
      this._seen.push(msg.id);
      if (this._seen.length > DEDUP_LIMIT) this._seen.shift();
    }

    const handler = this._handlers.get(msg.type);
    if (handler) {
      try { handler(fromPeerId, msg); } catch (e) {
        console.error(`[MessageRouter] Error handling "${msg.type}":`, e);
      }
    }
  }
}
