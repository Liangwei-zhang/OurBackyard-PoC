import { EventBus } from '../event-bus.js';
import { uuid } from '../utils.js';

// ── LWW-Register ──────────────────────────────────────────────────────────────

/**
 * LWWRegister — Last-Writer-Wins Register using logical (Lamport) timestamps.
 *
 * Merge rule:
 *  - Higher timestamp wins
 *  - Tie-break by peerId string comparison (lexicographically larger wins)
 *
 * Usage:
 *  const reg = new LWWRegister('peer1');
 *  reg.set('hello');
 *  reg.merge(remoteReg.toJSON());
 *  console.log(reg.value); // 'hello' or remote value, whichever is newer
 */
export class LWWRegister {
  /**
   * @param {string} peerId
   */
  constructor(peerId) {
    if (!peerId) throw new TypeError('peerId is required');
    this._peerId = peerId;
    this._value = null;
    this._timestamp = 0;
    this._writerId = null;
  }

  /** @returns {*} Current value */
  get value() { return this._value; }

  /** @returns {number} Current timestamp */
  get timestamp() { return this._timestamp; }

  /** @returns {string|null} Peer that last wrote */
  get writerId() { return this._writerId; }

  /**
   * Set a new value with current timestamp.
   * @param {*} value
   * @returns {this}
   */
  set(value) {
    this._timestamp = Date.now();
    this._value = value;
    this._writerId = this._peerId;
    return this;
  }

  /**
   * Merge a remote register state. Higher timestamp wins; ties broken by peerId.
   * @param {{ value: *, timestamp: number, writerId: string }} remote
   * @returns {this}
   */
  merge(remote) {
    if (!remote || typeof remote !== 'object') return this;
    const { value, timestamp, writerId } = remote;
    if (
      timestamp > this._timestamp ||
      (timestamp === this._timestamp && writerId > this._writerId)
    ) {
      this._value = value;
      this._timestamp = timestamp;
      this._writerId = writerId;
    }
    return this;
  }

  /**
   * Serialize to a plain object for network transfer.
   * @returns {{ value: *, timestamp: number, writerId: string|null }}
   */
  toJSON() {
    return { value: this._value, timestamp: this._timestamp, writerId: this._writerId };
  }

  /**
   * Reconstruct a LWWRegister from a serialized object.
   * @param {string} peerId
   * @param {{ value: *, timestamp: number, writerId: string|null }} json
   * @returns {LWWRegister}
   */
  static fromJSON(peerId, json) {
    const reg = new LWWRegister(peerId);
    if (json) {
      reg._value = json.value;
      reg._timestamp = json.timestamp || 0;
      reg._writerId = json.writerId || null;
    }
    return reg;
  }
}

// ── OR-Set ────────────────────────────────────────────────────────────────────

/**
 * ORSet — Observed-Remove Set (add-wins).
 *
 * Rules:
 *  - Each add generates a unique tag (peerId + counter)
 *  - Remove only tombstones the locally known tags for that element
 *  - Concurrent add+remove → element is present (add wins)
 *  - Merge: union of elements & tags, union of tombstones, then filter tombstoned tags
 *
 * Usage:
 *  const s = new ORSet('peer1');
 *  s.add('apple');
 *  s.remove('apple');   // only removes tags known at this point
 *  s.has('apple');      // false (if all known tags tombstoned)
 *  s.merge(remoteSet.toJSON()); // convergent merge
 */
export class ORSet {
  /**
   * @param {string} peerId
   */
  constructor(peerId) {
    if (!peerId) throw new TypeError('peerId is required');
    this._peerId = peerId;
    this._counter = 0;
    /** @type {Map<string, Set<string>>} element -> Set of unique tags */
    this._elements = new Map();
    /** @type {Set<string>} tombstoned tags */
    this._tombstones = new Set();
  }

  /**
   * Add an element.
   * @param {string} element
   * @returns {this}
   */
  add(element) {
    if (element == null) throw new TypeError('element must not be null/undefined');
    const tag = `${this._peerId}:${++this._counter}`;
    if (!this._elements.has(element)) this._elements.set(element, new Set());
    this._elements.get(element).add(tag);
    return this;
  }

  /**
   * Remove an element (tombstones all currently known tags for it).
   * @param {string} element
   * @returns {this}
   */
  remove(element) {
    const tags = this._elements.get(element);
    if (!tags) return this;
    for (const tag of tags) {
      this._tombstones.add(tag);
    }
    return this;
  }

  /**
   * Check if an element is present (has at least one non-tombstoned tag).
   * @param {string} element
   * @returns {boolean}
   */
  has(element) {
    const tags = this._elements.get(element);
    if (!tags) return false;
    for (const tag of tags) {
      if (!this._tombstones.has(tag)) return true;
    }
    return false;
  }

  /**
   * Return all present elements.
   * @returns {string[]}
   */
  values() {
    const result = [];
    for (const element of this._elements.keys()) {
      if (this.has(element)) result.push(element);
    }
    return result;
  }

  /**
   * Merge with a remote OR-Set state (commutative, associative, idempotent).
   * @param {{ elements: Array<{element:string, tags:string[]}>, tombstones: string[] }} remote
   * @returns {this}
   */
  merge(remote) {
    if (!remote || typeof remote !== 'object') return this;

    // Union elements
    for (const { element, tags } of remote.elements || []) {
      if (!this._elements.has(element)) this._elements.set(element, new Set());
      const localTags = this._elements.get(element);
      for (const tag of tags) localTags.add(tag);
    }

    // Union tombstones
    for (const tag of remote.tombstones || []) {
      this._tombstones.add(tag);
    }

    return this;
  }

  /**
   * Serialize for network transfer.
   * @returns {{ elements: Array<{element:string, tags:string[]}>, tombstones: string[] }}
   */
  toJSON() {
    const elements = [];
    for (const [element, tags] of this._elements) {
      elements.push({ element, tags: [...tags] });
    }
    return { elements, tombstones: [...this._tombstones] };
  }

  /**
   * Reconstruct from serialized state.
   * @param {string} peerId
   * @param {{ elements: Array<{element:string, tags:string[]}>, tombstones: string[] }} json
   * @returns {ORSet}
   */
  static fromJSON(peerId, json) {
    const set = new ORSet(peerId);
    if (json) set.merge(json);
    return set;
  }
}

// ── G-Counter ─────────────────────────────────────────────────────────────────

/**
 * GCounter — Grow-only counter (one value per peer, value = sum).
 *
 * Rules:
 *  - Each peer can only increment their own slot
 *  - Merge: take the max value for each peer
 *  - Value: sum of all peer values
 *
 * Usage:
 *  const c = new GCounter('peer1');
 *  c.increment();   // peer1's slot += 1
 *  c.increment(5);  // peer1's slot += 5
 *  c.value;         // sum of all peers
 *  c.merge(remoteCounter.toJSON());
 */
export class GCounter {
  /**
   * @param {string} peerId
   */
  constructor(peerId) {
    if (!peerId) throw new TypeError('peerId is required');
    this._peerId = peerId;
    /** @type {Map<string, number>} peerId -> count */
    this._counts = new Map();
    this._counts.set(peerId, 0);
  }

  /**
   * Increment the local peer's count.
   * @param {number} [amount=1]
   * @returns {this}
   */
  increment(amount = 1) {
    if (typeof amount !== 'number' || amount <= 0) throw new TypeError('amount must be a positive number');
    const current = this._counts.get(this._peerId) || 0;
    this._counts.set(this._peerId, current + amount);
    return this;
  }

  /**
   * Total value (sum of all peer counts).
   * @returns {number}
   */
  get value() {
    let sum = 0;
    for (const v of this._counts.values()) sum += v;
    return sum;
  }

  /**
   * Get individual peer count.
   * @param {string} peerId
   * @returns {number}
   */
  getCount(peerId) {
    return this._counts.get(peerId) || 0;
  }

  /**
   * Merge with a remote counter state (take max per peer).
   * @param {{ counts: Array<{peerId:string, count:number}> }} remote
   * @returns {this}
   */
  merge(remote) {
    if (!remote || typeof remote !== 'object') return this;
    for (const { peerId, count } of remote.counts || []) {
      const local = this._counts.get(peerId) || 0;
      if (count > local) this._counts.set(peerId, count);
    }
    return this;
  }

  /**
   * Serialize for network transfer.
   * @returns {{ counts: Array<{peerId:string, count:number}> }}
   */
  toJSON() {
    const counts = [];
    for (const [peerId, count] of this._counts) {
      counts.push({ peerId, count });
    }
    return { counts };
  }

  /**
   * Reconstruct from serialized state.
   * @param {string} peerId
   * @param {{ counts: Array<{peerId:string, count:number}> }} json
   * @returns {GCounter}
   */
  static fromJSON(peerId, json) {
    const counter = new GCounter(peerId);
    if (json) counter.merge(json);
    return counter;
  }
}

// ── CRDTManager ───────────────────────────────────────────────────────────────

/**
 * CRDTManager — manages a collection of named CRDTs and handles network sync.
 *
 * Events: 'crdt:updated', 'crdt:merged'
 */
export class CRDTManager extends EventBus {
  /**
   * @param {object} opts
   * @param {import('./message-router.js').MessageRouter} opts.router
   * @param {string} opts.peerId
   */
  constructor({ router, peerId }) {
    super();
    if (!router) throw new TypeError('router is required');
    if (!peerId) throw new TypeError('peerId is required');

    this._router = router;
    this._peerId = peerId;

    /** @type {Map<string, LWWRegister|ORSet|GCounter>} */
    this._crdts = new Map();

    router.handle('CRDT_UPDATE', (from, msg) => this._onCRDTUpdate(from, msg));
  }

  /**
   * Get or create a named LWWRegister.
   * @param {string} name
   * @returns {LWWRegister}
   */
  lwwRegister(name) {
    if (!this._crdts.has(name)) this._crdts.set(name, new LWWRegister(this._peerId));
    return this._crdts.get(name);
  }

  /**
   * Get or create a named ORSet.
   * @param {string} name
   * @returns {ORSet}
   */
  orSet(name) {
    if (!this._crdts.has(name)) this._crdts.set(name, new ORSet(this._peerId));
    return this._crdts.get(name);
  }

  /**
   * Get or create a named GCounter.
   * @param {string} name
   * @returns {GCounter}
   */
  gCounter(name) {
    if (!this._crdts.has(name)) this._crdts.set(name, new GCounter(this._peerId));
    return this._crdts.get(name);
  }

  /**
   * Broadcast current state of a named CRDT to a peer.
   * @param {string} name
   * @param {string} toPeerId
   */
  broadcastTo(name, toPeerId) {
    const crdt = this._crdts.get(name);
    if (!crdt) return;
    const type = crdt instanceof LWWRegister ? 'lww' : crdt instanceof ORSet ? 'orset' : 'gcounter';
    this._sendTo(toPeerId, {
      type: 'CRDT_UPDATE',
      id: uuid(),
      name,
      crdtType: type,
      state: crdt.toJSON(),
    });
  }

  /** @private */
  _onCRDTUpdate(from, msg) {
    const { name, crdtType, state } = msg;
    let crdt = this._crdts.get(name);

    if (!crdt) {
      switch (crdtType) {
        case 'lww': crdt = new LWWRegister(this._peerId); break;
        case 'orset': crdt = new ORSet(this._peerId); break;
        case 'gcounter': crdt = new GCounter(this._peerId); break;
        default: return;
      }
      this._crdts.set(name, crdt);
    }

    try {
      crdt.merge(state);
      this.emit('crdt:merged', { name, crdtType, from });
    } catch (e) {
      // swallow merge errors
    }
  }

  /** @private */
  _sendTo(peerId, message) {
    if (typeof this._sendFn === 'function') {
      try { this._sendFn(peerId, message); } catch (e) { /* swallow */ }
    } else {
      this.emit('send', peerId, message);
    }
  }

  /**
   * Set the send function for outbound messages.
   * @param {Function} fn - (toPeerId, message) => void
   */
  setSendFn(fn) {
    this._sendFn = fn;
  }
}
