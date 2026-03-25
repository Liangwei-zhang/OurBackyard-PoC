/**
 * Lightweight EventBus (EventEmitter for browser + Node.js).
 * Modules extend this to emit/listen for events without circular imports.
 */
export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Register an event listener.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  }

  /**
   * Register a one-time event listener.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  once(event, fn) {
    const wrapper = (...args) => { fn(...args); this.off(event, wrapper); };
    return this.on(event, wrapper);
  }

  /**
   * Remove an event listener.
   * @param {string} event
   * @param {Function} fn
   * @returns {this}
   */
  off(event, fn) {
    if (!this._listeners.has(event)) return this;
    const updated = this._listeners.get(event).filter(l => l !== fn);
    if (updated.length) this._listeners.set(event, updated);
    else this._listeners.delete(event);
    return this;
  }

  /**
   * Emit an event.
   * @param {string} event
   * @param {...*} args
   * @returns {boolean} true if any listeners were called
   */
  emit(event, ...args) {
    const listeners = this._listeners.get(event);
    if (!listeners || listeners.length === 0) return false;
    for (const fn of listeners.slice()) {
      try { fn(...args); } catch (err) { console.error(`EventBus error on '${event}':`, err); }
    }
    return true;
  }

  /**
   * Remove all listeners for an event, or all events if no event given.
   * @param {string} [event]
   */
  removeAllListeners(event) {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
  }
}
