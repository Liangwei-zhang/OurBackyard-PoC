/**
 * EventBus — Tiny typed EventEmitter (no Node.js dependency).
 * Used by all SDK modules to communicate without direct coupling.
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return this;
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  off(event, fn) {
    const handlers = this._handlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(fn);
      if (idx !== -1) handlers.splice(idx, 1);
    }
    return this;
  }

  /**
   * Emit an event, calling all registered handlers.
   * @param {string} event
   * @param {...*} args
   */
  emit(event, ...args) {
    const handlers = this._handlers.get(event);
    if (handlers) {
      for (const fn of handlers.slice()) {
        try { fn(...args); } catch (e) { console.error(`[EventBus] Error in handler for "${event}":`, e); }
      }
    }
  }

  /**
   * Subscribe to an event exactly once.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  /**
   * Remove all handlers for a given event (or all events if omitted).
   * @param {string} [event]
   */
  removeAllListeners(event) {
    if (event) {
      this._handlers.delete(event);
    } else {
      this._handlers.clear();
    }
  }
}
