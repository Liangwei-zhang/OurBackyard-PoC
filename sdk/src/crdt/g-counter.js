/**
 * GCounter — Grow-only Counter CRDT.
 *
 * Each peer maintains its own counter. The global value is the sum of all peers.
 * Merging takes component-wise maximums, so counters can only grow.
 * Useful for view counts, likes, downloads, etc.
 */

export class GCounter {
  /**
   * @param {string} peerId — The local peer identifier.
   * @param {Object<string,number>} [initialState={}] — Optional initial state.
   */
  constructor(peerId, initialState = {}) {
    this._peerId = peerId;
    /** @type {Object<string, number>} */
    this._counts = { ...initialState };
    if (!this._counts[peerId]) this._counts[peerId] = 0;
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Increment the local peer's counter.
   * @param {number} [amount=1]
   */
  increment(amount = 1) {
    if (amount <= 0) throw new RangeError('GCounter: increment amount must be positive');
    this._counts[this._peerId] = (this._counts[this._peerId] || 0) + amount;
  }

  /**
   * Get the total count across all peers.
   * @returns {number}
   */
  value() {
    return Object.values(this._counts).reduce((sum, v) => sum + v, 0);
  }

  /**
   * Merge a remote counter state (component-wise maximum).
   * @param {{ counts: Object<string,number> }|Object<string,number>} remote
   */
  merge(remote) {
    if (!remote) return;
    const remoteCounts = remote.counts || remote;
    for (const [peer, count] of Object.entries(remoteCounts)) {
      this._counts[peer] = Math.max(this._counts[peer] || 0, count || 0);
    }
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {{ counts: Object<string,number> }}
   */
  toJSON() {
    return { counts: { ...this._counts } };
  }

  /**
   * Deserialize a GCounter from its JSON representation.
   * @param {string} peerId
   * @param {{ counts: Object<string,number> }} data
   * @returns {GCounter}
   */
  static fromJSON(peerId, data) {
    const counts = (data && data.counts) ? data.counts : {};
    return new GCounter(peerId, counts);
  }
}
