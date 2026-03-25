/**
 * @file memory-storage.js
 * @description In-memory IStorage implementation (for testing and ephemeral use).
 * Zero external dependencies.
 */

import { IStorage } from './storage-interface.js';

export class MemoryStorage extends IStorage {
  constructor() {
    super();
    /** @type {Map<string, *>} */
    this._store = new Map();
  }

  async get(key) { return this._store.get(key) ?? null; }
  async set(key, value) { this._store.set(key, value); }
  async delete(key) { this._store.delete(key); }
  async keys() { return [...this._store.keys()]; }
  async clear() { this._store.clear(); }
}

export default MemoryStorage;
