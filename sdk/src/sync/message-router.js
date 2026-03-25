import { EventBus } from '../event-bus.js';

/**
 * Message priority levels.
 */
export const Priority = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 });

/**
 * MessageRouter — typed message routing with dedup, priority, timeout, and metrics.
 *
 * Features:
 *  - O(1) dedup using LRU Set (capacity configurable)
 *  - Handler priority (HIGH, NORMAL, LOW) — reserved for future queue ordering
 *  - Per-handler timeout (kills handlers that take >5s by default)
 *  - Wildcard handler: handle('*', fn) for logging/monitoring
 *  - Metrics: messages routed, handlers invoked, errors caught
 *  - Events: 'route:error', 'route:unhandled'
 */
export class MessageRouter extends EventBus {
  /**
   * @param {object} [opts]
   * @param {number} [opts.dedupCapacity=10000] - Max number of message IDs to remember
   * @param {number} [opts.handlerTimeoutMs=5000] - Max handler execution time
   */
  constructor({ dedupCapacity = 10000, handlerTimeoutMs = 5000 } = {}) {
    super();
    this._dedupCapacity = dedupCapacity;
    this._handlerTimeoutMs = handlerTimeoutMs;
    /** @type {Map<string, Array<{fn: Function, priority: number}>>} */
    this._handlers = new Map();
    /** @type {Array<{fn: Function, priority: number}>} */
    this._wildcardHandlers = [];
    /** @type {Set<string>} */
    this._seen = new Set();
    /** @type {string[]} */
    this._seenOrder = [];
    /** Metrics */
    this.metrics = { routed: 0, invoked: 0, errors: 0, duplicates: 0 };
  }

  /**
   * Register a handler for a message type.
   * Use '*' as type to register a wildcard handler (called for every message).
   * @param {string} type - Message type or '*' for wildcard
   * @param {Function} fn - Handler: (fromPeerId, message) => void|Promise<void>
   * @param {number} [priority=Priority.NORMAL]
   * @returns {this}
   */
  handle(type, fn, priority = Priority.NORMAL) {
    if (typeof type !== 'string' || !type) throw new TypeError('type must be a non-empty string');
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    if (type === '*') {
      this._wildcardHandlers.push({ fn, priority });
    } else {
      if (!this._handlers.has(type)) this._handlers.set(type, []);
      this._handlers.get(type).push({ fn, priority });
    }
    return this;
  }

  /**
   * Remove a previously registered handler.
   * @param {string} type
   * @param {Function} fn
   * @returns {this}
   */
  unhandle(type, fn) {
    if (type === '*') {
      this._wildcardHandlers = this._wildcardHandlers.filter(h => h.fn !== fn);
    } else if (this._handlers.has(type)) {
      const updated = this._handlers.get(type).filter(h => h.fn !== fn);
      if (updated.length) this._handlers.set(type, updated);
      else this._handlers.delete(type);
    }
    return this;
  }

  /**
   * Route a message from a peer. Deduplicates using message.id.
   * @param {string} fromPeerId
   * @param {object} message - Must have { type: string, id?: string }
   * @returns {Promise<boolean>} true if message was routed to at least one handler
   */
  async route(fromPeerId, message) {
    if (!message || typeof message !== 'object') return false;
    const { type, id } = message;
    if (!type) return false;

    // Dedup by message id
    if (id) {
      if (this._seen.has(id)) {
        this.metrics.duplicates++;
        return false;
      }
      this._seen.add(id);
      this._seenOrder.push(id);
      if (this._seenOrder.length > this._dedupCapacity) {
        this._seen.delete(this._seenOrder.shift());
      }
    }

    this.metrics.routed++;
    const typeHandlers = this._handlers.get(type) || [];
    const allHandlers = [...typeHandlers, ...this._wildcardHandlers];

    if (allHandlers.length === 0) {
      this.emit('route:unhandled', type, fromPeerId, message);
      return false;
    }

    // Sort by priority (lower number = higher priority)
    allHandlers.sort((a, b) => a.priority - b.priority);

    let invoked = false;
    for (const { fn } of allHandlers) {
      this.metrics.invoked++;
      invoked = true;
      try {
        await this._invokeWithTimeout(fn, fromPeerId, message);
      } catch (err) {
        this.metrics.errors++;
        this.emit('route:error', { type, fromPeerId, message, error: err });
      }
    }
    return invoked;
  }

  /**
   * @private
   */
  _invokeWithTimeout(fn, fromPeerId, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Handler timeout after ${this._handlerTimeoutMs}ms for type '${message.type}'`));
      }, this._handlerTimeoutMs);
      try {
        Promise.resolve(fn(fromPeerId, message)).then(
          v => { clearTimeout(timer); resolve(v); },
          e => { clearTimeout(timer); reject(e); }
        );
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Reset dedup state (useful for testing).
   */
  resetDedup() {
    this._seen.clear();
    this._seenOrder.length = 0;
  }

  /**
   * Reset metrics.
   */
  resetMetrics() {
    this.metrics = { routed: 0, invoked: 0, errors: 0, duplicates: 0 };
  }
}
