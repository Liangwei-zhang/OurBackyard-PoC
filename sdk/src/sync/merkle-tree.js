/**
 * MerkleTree — Binary Merkle tree over key-value pairs.
 *
 * Entries are sorted by key, hashed, then organised into a binary tree where
 * each internal node is the hash of its two children concatenated.
 * The root hash uniquely fingerprints the entire data set.
 *
 * This implementation is designed for incremental updates and efficient
 * comparison between two trees to find differing leaves.
 */

import { sha256hex } from '../utils.js';

export class MerkleTree {
  /**
   * @param {Function} [hashFn=sha256hex] — Async hash function: (string) → Promise<string>
   */
  constructor(hashFn = sha256hex) {
    this._hashFn = hashFn;
    /** @type {Array<{ key: string, hash: string }>} sorted leaf entries */
    this._leaves = [];
    /** @type {string[][]} _levels[0] = leaf hashes, _levels[n] = root */
    this._levels = [];
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Build the tree from an array of key-hash pairs.
   * @param {Array<{ key: string, hash: string }>} entries
   */
  async build(entries) {
    // Sort by key for deterministic ordering
    this._leaves = [...entries].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    await this._buildLevels();
  }

  /**
   * Get the root hash (empty string if tree is empty).
   * @returns {string}
   */
  getRootHash() {
    if (this._levels.length === 0) return '';
    const top = this._levels[this._levels.length - 1];
    return top[0] || '';
  }

  /**
   * Get the hashes at a specific level (0 = leaves, top = root).
   * @param {number} level
   * @returns {string[]}
   */
  getLevel(level) {
    return this._levels[level] ? [...this._levels[level]] : [];
  }

  /**
   * Total number of levels in the tree.
   * @returns {number}
   */
  get depth() {
    return this._levels.length;
  }

  /**
   * Insert or update a single entry and rebuild the tree.
   * O(n log n) — acceptable for small-to-medium data sets.
   * @param {string} key
   * @param {string} hash
   */
  async insert(key, hash) {
    const idx = this._leaves.findIndex(l => l.key === key);
    if (idx !== -1) {
      this._leaves[idx] = { key, hash };
    } else {
      this._leaves.push({ key, hash });
      this._leaves.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    }
    await this._buildLevels();
  }

  /**
   * Diff two trees and return keys of differing leaves.
   * Uses root hash comparison first, then drills down to find differences.
   * @param {MerkleTree} treeA
   * @param {MerkleTree} treeB
   * @returns {Promise<string[]>} — keys of leaves that differ or exist in only one tree
   */
  static async diff(treeA, treeB) {
    if (treeA.getRootHash() === treeB.getRootHash()) return [];

    // Build maps for fast lookup
    const aMap = new Map(treeA._leaves.map(l => [l.key, l.hash]));
    const bMap = new Map(treeB._leaves.map(l => [l.key, l.hash]));

    const diffKeys = new Set();

    // Keys in A but not B, or hash differs
    for (const [key, hash] of aMap) {
      if (!bMap.has(key) || bMap.get(key) !== hash) diffKeys.add(key);
    }

    // Keys in B but not A
    for (const [key] of bMap) {
      if (!aMap.has(key)) diffKeys.add(key);
    }

    return [...diffKeys];
  }

  /**
   * Return a serializable snapshot of the tree (levels only, not raw data).
   * Used for exchanging intermediate node hashes with a peer.
   * @returns {{ rootHash: string, levels: string[][], leafCount: number }}
   */
  getSnapshot() {
    return {
      rootHash: this.getRootHash(),
      levels: this._levels.map(l => [...l]),
      leafCount: this._leaves.length,
    };
  }

  /**
   * Get sorted leaf keys.
   * @returns {string[]}
   */
  getLeafKeys() {
    return this._leaves.map(l => l.key);
  }

  // ─────────────────────────── Internal ───────────────────────────

  async _buildLevels() {
    this._levels = [];
    if (this._leaves.length === 0) return;

    // Level 0: leaf hashes (already provided, just extract)
    let currentLevel = this._leaves.map(l => l.hash);
    this._levels.push(currentLevel);

    // Build up the tree
    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left  = currentLevel[i];
        const right = currentLevel[i + 1] !== undefined ? currentLevel[i + 1] : left;
        nextLevel.push(await this._hashFn(left + right));
      }
      this._levels.push(nextLevel);
      currentLevel = nextLevel;
    }
  }
}
