/**
 * @file event-bus.js
 * @description Enhanced typed event bus with once(), removeAllListeners(), and listener count tracking.
 * Zero external dependencies.
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    /** @type {Map<string, Set<Function>>} */
    this._onceListeners = new Map();
  }

  /**
   * Register a persistent listener for an event type.
   * @param {string} event
   * @param {Function} listener
   * @returns {this}
   */
  on(event, listener) {
    if (typeof event !== 'string' || !event) throw new TypeError('event must be a non-empty string');
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(listener);
    return this;
  }

  /**
   * Register a one-time listener that fires at most once.
   * @param {string} event
   * @param {Function} listener
   * @returns {this}
   */
  once(event, listener) {
    if (typeof event !== 'string' || !event) throw new TypeError('event must be a non-empty string');
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (!this._onceListeners.has(event)) this._onceListeners.set(event, new Set());
    this._onceListeners.get(event).add(listener);
    return this;
  }

  /**
   * Remove a specific listener for an event type.
   * @param {string} event
   * @param {Function} listener
   * @returns {this}
   */
  off(event, listener) {
    this._listeners.get(event)?.delete(listener);
    this._onceListeners.get(event)?.delete(listener);
    return this;
  }

  /**
   * Remove all listeners for an event type, or all listeners if no event is specified.
   * @param {string} [event]
   * @returns {this}
   */
  removeAllListeners(event) {
    if (event !== undefined) {
      this._listeners.delete(event);
      this._onceListeners.delete(event);
    } else {
      this._listeners.clear();
      this._onceListeners.clear();
    }
    return this;
  }

  /**
   * Emit an event, calling all registered listeners with the provided data.
   * @param {string} event
   * @param {*} data
   * @returns {boolean} true if any listeners were called
   */
  emit(event, data) {
    let called = false;
    const persistent = this._listeners.get(event);
    if (persistent) {
      for (const fn of persistent) {
        try { fn(data); } catch (e) { /* isolate listener errors */ }
        called = true;
      }
    }
    const once = this._onceListeners.get(event);
    if (once && once.size > 0) {
      const fns = [...once];
      this._onceListeners.delete(event);
      for (const fn of fns) {
        try { fn(data); } catch (e) { /* isolate listener errors */ }
        called = true;
      }
    }
    return called;
  }

  /**
   * Return the number of listeners registered for an event.
   * @param {string} event
   * @returns {number}
   */
  listenerCount(event) {
    return (this._listeners.get(event)?.size ?? 0) +
           (this._onceListeners.get(event)?.size ?? 0);
  }
}

export default EventBus;
