/**
 * ORSet — Observed-Remove Set CRDT.
 *
 * Allows elements to be added and removed without conflicts.
 * Each add operation attaches a unique tag; remove deletes all tags for an element.
 * An element is in the set if it has at least one surviving tag.
 *
 * Based on the standard OR-Set (Add-Wins variant):
 *   - add(x)    → adds a unique (element, tag) pair
 *   - remove(x) → removes all local (element, tag) pairs for x
 *   - merge     → union of add-sets, intersection of remove reasoning via tags
 */

import { uuid } from '../utils.js';

export class ORSet {
  /**
   * @param {string} peerId — The local peer identifier.
   */
  constructor(peerId) {
    this._peerId = peerId;
    /**
     * Map of element → Set of unique tags currently "alive" for that element.
     * @type {Map<string, Set<string>>}
     */
    this._entries = new Map();
    /**
     * Set of tombstoned tags (removed tags).
     * @type {Set<string>}
     */
    this._tombstones = new Set();
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Add an element to the set.
   * @param {*} element — Will be coerced to string key via JSON.stringify.
   * @returns {{ element: string, tag: string }} — The operation (for broadcasting).
   */
  add(element) {
    const key = this._key(element);
    const tag = `${this._peerId}:${uuid()}`;
    if (!this._entries.has(key)) this._entries.set(key, new Set());
    this._entries.get(key).add(tag);
    // Remove from tombstones if re-added
    this._tombstones.delete(tag);
    return { element: key, tag };
  }

  /**
   * Remove an element from the set (removes all current tags).
   * @param {*} element
   * @returns {{ element: string, tags: string[] }} — The operation (for broadcasting).
   */
  remove(element) {
    const key = this._key(element);
    const tags = this._entries.has(key)
      ? [...this._entries.get(key)]
      : [];
    // Tombstone all current tags for this element
    for (const tag of tags) this._tombstones.add(tag);
    this._entries.delete(key);
    return { element: key, tags };
  }

  /**
   * Check if an element is in the set.
   * @param {*} element
   * @returns {boolean}
   */
  has(element) {
    const key = this._key(element);
    const tags = this._entries.get(key);
    if (!tags || tags.size === 0) return false;
    // Filter out tombstoned tags
    for (const tag of tags) {
      if (!this._tombstones.has(tag)) return true;
    }
    return false;
  }

  /**
   * Get all current elements in the set.
   * @returns {Set<string>}
   */
  values() {
    const result = new Set();
    for (const [key, tags] of this._entries) {
      for (const tag of tags) {
        if (!this._tombstones.has(tag)) {
          result.add(key);
          break;
        }
      }
    }
    return result;
  }

  /**
   * Merge a remote ORSet state (union of entries, union of tombstones).
   * @param {{ entries: Object<string, string[]>, tombstones: string[] }} remote
   */
  merge(remote) {
    if (!remote) return;

    // Merge tombstones
    for (const tag of (remote.tombstones || [])) {
      this._tombstones.add(tag);
    }

    // Merge entries
    for (const [element, tags] of Object.entries(remote.entries || {})) {
      if (!this._entries.has(element)) this._entries.set(element, new Set());
      const localTags = this._entries.get(element);
      for (const tag of tags) {
        if (!this._tombstones.has(tag)) localTags.add(tag);
      }
    }

    // Clean up any locally-present tags that are now tombstoned
    for (const [element, tags] of this._entries) {
      for (const tag of [...tags]) {
        if (this._tombstones.has(tag)) tags.delete(tag);
      }
      if (tags.size === 0) this._entries.delete(element);
    }
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {{ entries: Object<string, string[]>, tombstones: string[] }}
   */
  toJSON() {
    const entries = {};
    for (const [key, tags] of this._entries) {
      entries[key] = [...tags];
    }
    return {
      entries,
      tombstones: [...this._tombstones],
    };
  }

  /**
   * Deserialize an ORSet from its JSON representation.
   * @param {string} peerId
   * @param {{ entries: Object<string,string[]>, tombstones: string[] }} data
   * @returns {ORSet}
   */
  static fromJSON(peerId, data) {
    const set = new ORSet(peerId);
    if (data) {
      for (const [element, tags] of Object.entries(data.entries || {})) {
        set._entries.set(element, new Set(tags));
      }
      for (const tag of (data.tombstones || [])) {
        set._tombstones.add(tag);
      }
    }
    return set;
  }

  // ─────────────────────────── Internal ───────────────────────────

  /**
   * Convert an element to a stable string key.
   * @param {*} element
   * @returns {string}
   */
  _key(element) {
    if (typeof element === 'string') return element;
    return JSON.stringify(element);
  }
}
