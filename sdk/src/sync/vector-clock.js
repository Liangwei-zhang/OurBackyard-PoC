/**
 * VectorClock — Causal ordering for distributed events.
 *
 * Each node maintains a counter for itself and all peers it has communicated with.
 * Comparing two clocks determines causal ordering: before, after, concurrent, or equal.
 */

export class VectorClock {
  /**
   * @param {string} peerId — The local peer identifier.
   * @param {Object} [initialState={}] — Optional initial clock state.
   */
  constructor(peerId, initialState = {}) {
    this._peerId = peerId;
    /** @type {Object<string, number>} */
    this._clock = { ...initialState };
    if (!this._clock[peerId]) this._clock[peerId] = 0;
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Increment the local peer's counter (tick before sending an event).
   * @returns {Object} snapshot of the clock after tick
   */
  tick() {
    this._clock[this._peerId] = (this._clock[this._peerId] || 0) + 1;
    return this.toJSON();
  }

  /**
   * Merge a remote clock state into the local clock.
   * Takes the component-wise maximum of each peer counter.
   * @param {Object} remote — Plain object { peerId: counter }
   */
  merge(remote) {
    if (!remote || typeof remote !== 'object') return;
    for (const [peer, counter] of Object.entries(remote)) {
      this._clock[peer] = Math.max(this._clock[peer] || 0, counter || 0);
    }
  }

  /**
   * Compare this clock with another.
   * @param {Object|VectorClock} other
   * @returns {'before'|'after'|'concurrent'|'equal'}
   */
  compare(other) {
    const otherClock = other instanceof VectorClock ? other._clock : other;
    const allPeers = new Set([...Object.keys(this._clock), ...Object.keys(otherClock)]);

    let lessThan = false;
    let greaterThan = false;

    for (const peer of allPeers) {
      const a = this._clock[peer] || 0;
      const b = otherClock[peer] || 0;
      if (a < b) lessThan = true;
      if (a > b) greaterThan = true;
    }

    if (!lessThan && !greaterThan) return 'equal';
    if (lessThan && !greaterThan) return 'before';
    if (greaterThan && !lessThan) return 'after';
    return 'concurrent';
  }

  /**
   * Serialize the clock to a plain JSON object.
   * @returns {Object}
   */
  toJSON() {
    return { ...this._clock };
  }

  /**
   * Deserialize a VectorClock from a plain JSON object.
   * @param {string} peerId
   * @param {Object} data
   * @returns {VectorClock}
   */
  static fromJSON(peerId, data) {
    return new VectorClock(peerId, data || {});
  }
}
