import { IStorage } from './storage-interface.js';

/**
 * In-memory storage implementation of IStorage.
 * Suitable for testing and ephemeral sessions.
 */
export class MemoryStorage extends IStorage {
  constructor() {
    super();
    /** @type {Map<string, {value:*, updatedAt:number}>} */
    this._store = new Map();
  }

  /** @override */
  async put(key, value) {
    if (key == null) throw new TypeError('key must not be null/undefined');
    this._store.set(String(key), { value, updatedAt: Date.now() });
  }

  /** @override */
  async get(key) {
    const entry = this._store.get(String(key));
    return entry ? entry.value : null;
  }

  /** @override */
  async delete(key) {
    this._store.delete(String(key));
  }

  /** @override */
  async getAll({ since = 0 } = {}) {
    const results = [];
    for (const [key, entry] of this._store) {
      if (entry.updatedAt >= since) {
        results.push({ key, value: entry.value, updatedAt: entry.updatedAt });
      }
    }
    return results;
  }

  /** @override */
  async count() {
    return this._store.size;
  }

  /** @override */
  async clear() {
    this._store.clear();
  }
}
