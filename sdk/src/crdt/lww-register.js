/**
 * LWWRegister — Last-Writer-Wins Register CRDT.
 *
 * Simplest CRDT for single-value fields. On concurrent writes, the one
 * with the highest timestamp wins. When timestamps are equal, the write
 * from the peer with the lexicographically larger peerId wins (tie-break).
 */

export class LWWRegister {
  /**
   * @param {string} peerId — The local peer identifier.
   * @param {*} [initialValue=null] — Optional initial value.
   */
  constructor(peerId, initialValue = null) {
    this._peerId = peerId;
    this._value = initialValue;
    this._timestamp = initialValue !== null ? Date.now() : 0;
    this._authorPeerId = peerId;
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Set a new value with the current timestamp.
   * @param {*} value
   * @returns {{ peerId: string, value: *, timestamp: number }}
   */
  set(value) {
    this._value = value;
    this._timestamp = Date.now();
    this._authorPeerId = this._peerId;
    return { peerId: this._peerId, value, timestamp: this._timestamp };
  }

  /**
   * Get the current value.
   * @returns {*}
   */
  get() {
    return this._value;
  }

  /**
   * Merge a remote update. Highest timestamp wins; on tie, larger peerId wins.
   * @param {{ peerId: string, value: *, timestamp: number }} remote
   */
  merge(remote) {
    if (!remote || typeof remote.timestamp !== 'number') return;

    const remoteWins =
      remote.timestamp > this._timestamp ||
      (remote.timestamp === this._timestamp &&
        (remote.peerId || '') > (this._authorPeerId || ''));

    if (remoteWins) {
      this._value = remote.value;
      this._timestamp = remote.timestamp;
      this._authorPeerId = remote.peerId || '';
    }
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {{ peerId: string, value: *, timestamp: number }}
   */
  toJSON() {
    return {
      peerId: this._authorPeerId,
      value: this._value,
      timestamp: this._timestamp,
    };
  }

  /**
   * Deserialize an LWWRegister from its JSON representation.
   * @param {string} localPeerId
   * @param {{ peerId: string, value: *, timestamp: number }} data
   * @returns {LWWRegister}
   */
  static fromJSON(localPeerId, data) {
    const reg = new LWWRegister(localPeerId);
    if (data) {
      reg._value = data.value !== undefined ? data.value : null;
      reg._timestamp = data.timestamp || 0;
      reg._authorPeerId = data.peerId || localPeerId;
    }
    return reg;
  }
}
