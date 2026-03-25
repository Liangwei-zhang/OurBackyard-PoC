/**
 * @file message-router.js
 * @description Message type routing with O(1) Set-based dedup (50,000 capacity, LRU eviction).
 * Replaces the original Array.includes() O(n) approach.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('MessageRouter');

export class MessageRouter extends EventBus {
  constructor() {
    super();
    /** @type {Map<string, Function[]>} type → handlers */
    this._handlers = new Map();
    /** @type {Set<string>} seen message IDs — O(1) lookup */
    this._seen = new Set();
    /** @type {string[]} insertion-order queue for LRU eviction */
    this._seenOrder = [];
  }

  /**
   * Register a handler for a specific message type.
   * @param {string} type
   * @param {Function} handler
   * @returns {this}
   */
  on(type, handler) {
    if (typeof type !== 'string' || !type) throw new TypeError('type must be a non-empty string');
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(handler);
    return this;
  }

  /**
   * Remove a handler for a specific message type.
   * @param {string} type
   * @param {Function} handler
   * @returns {this}
   */
  off(type, handler) {
    const handlers = this._handlers.get(type);
    if (!handlers) return this;
    const idx = handlers.indexOf(handler);
    if (idx !== -1) handlers.splice(idx, 1);
    return this;
  }

  /**
   * Route an incoming message to registered handlers.
   * Performs dedup check using the message's `id` field.
   *
   * @param {{ id?: string, type: string, [key: string]: * }} message
   * @param {string} [fromPeerId]
   * @returns {boolean} true if message was routed (not a duplicate or invalid)
   */
  route(message, fromPeerId) {
    // Validate
    if (!message || typeof message !== 'object') {
      log.warn('Dropping non-object message');
      return false;
    }

    const maxBytes = config.get('router.maxMessageBytes');
    const serialized = JSON.stringify(message);
    if (serialized.length > maxBytes) {
      log.warn(`Dropping oversized message: ${serialized.length} bytes > ${maxBytes}`);
      return false;
    }

    const { id, type } = message;
    if (!type) {
      log.warn('Dropping message without type field');
      return false;
    }

    // Dedup by message ID
    if (id) {
      if (this._seen.has(id)) {
        log.debug(`Dedup: dropping already-seen message id=${id}`);
        return false;
      }
      this._addToSeen(id);
    }

    // Dispatch to handlers with error isolation
    const handlers = this._handlers.get(type) ?? [];
    const wildcardHandlers = this._handlers.get('*') ?? [];
    const all = [...handlers, ...wildcardHandlers];

    if (all.length === 0) {
      log.debug(`No handlers for message type "${type}"`);
      return false;
    }

    for (const fn of all) {
      try {
        fn(message, fromPeerId);
      } catch (e) {
        log.error(`Handler error for type "${type}"`, e);
        this.emit('handler:error', { type, error: e, message });
      }
    }
    return true;
  }

  /**
   * Check if a message ID has already been seen.
   * @param {string} id
   * @returns {boolean}
   */
  hasSeen(id) {
    return this._seen.has(id);
  }

  /**
   * Clear the dedup set.
   */
  clearSeen() {
    this._seen.clear();
    this._seenOrder = [];
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /** @private */
  _addToSeen(id) {
    const capacity = config.get('router.dedupCapacity');
    this._seen.add(id);
    this._seenOrder.push(id);
    // LRU eviction when over capacity
    while (this._seen.size > capacity) {
      const oldest = this._seenOrder.shift();
      if (oldest) this._seen.delete(oldest);
    }
  }
}

export default MessageRouter;
