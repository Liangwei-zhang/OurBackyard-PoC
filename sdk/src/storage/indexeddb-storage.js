import { IStorage } from './storage-interface.js';

/**
 * IndexedDBStorage — persistent IStorage backed by the browser's IndexedDB.
 *
 * Schema:
 *   database : "ob_sdk_<dbName>" (default: "ob_sdk_default")
 *   version  : 1
 *   object store: "kv"
 *     keyPath: "key"
 *     fields : key (string), value (any), updatedAt (number)
 *
 * All operations are safe to call concurrently; each awaits the internal
 * `_ready` promise so callers don't need to call open() explicitly.
 *
 * Usage:
 *   const storage = new IndexedDBStorage('myNode');
 *   await storage.put('item:abc', { title: 'Lamp' });
 *   const item = await storage.get('item:abc');
 */
export class IndexedDBStorage extends IStorage {
  /**
   * @param {string} [dbName='default']  — unique name per P2P node / H3 cell
   * @param {number} [version=1]         — schema version (bump to trigger upgrades)
   */
  constructor(dbName = 'default', version = 1) {
    super();
    this._dbName  = `ob_sdk_${dbName}`;
    this._version = version;
    /** @type {Promise<IDBDatabase>} */
    this._ready   = this._open();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** @returns {Promise<IDBDatabase>} */
  _open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this environment'));
        return;
      }
      const req = indexedDB.open(this._dbName, this._version);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) {
          const store = db.createObjectStore('kv', { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };

      req.onsuccess  = (e) => resolve(e.target.result);
      req.onerror    = (e) => reject(e.target.error);
      req.onblocked  = ()  => reject(new Error('IndexedDB open blocked by another tab'));
    });
  }

  /**
   * Close the underlying database connection.
   * After calling this, no further operations should be performed.
   * @returns {Promise<void>}
   */
  async close() {
    const db = await this._ready;
    db.close();
  }

  /**
   * Delete the entire IndexedDB database.
   * Useful for reset / clear-all flows.
   * @returns {Promise<void>}
   */
  async destroy() {
    try {
      const db = await this._ready;
      db.close();
    } catch { /* ignore if already closed */ }
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this._dbName);
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
      // onblocked fires when other tabs have it open; resolve anyway
      req.onblocked = () => resolve();
    });
  }

  // ── IStorage interface ───────────────────────────────────────────────────────

  /** @override */
  async put(key, value) {
    if (key == null) throw new TypeError('key must not be null/undefined');
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req   = store.put({ key: String(key), value, updatedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /** @override */
  async get(key) {
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req   = store.get(String(key));
      req.onsuccess = (e) => resolve(e.target.result ? e.target.result.value : null);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /** @override */
  async delete(key) {
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req   = store.delete(String(key));
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /**
   * Return all records, optionally filtered by updatedAt >= since.
   * @override
   * @param {{ since?: number }} [opts]
   * @returns {Promise<Array<{key:string, value:*, updatedAt:number}>>}
   */
  async getAll({ since = 0 } = {}) {
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx      = db.transaction('kv', 'readonly');
      const store   = tx.objectStore('kv');
      const results = [];

      if (since > 0) {
        // Use the updatedAt index with a lower-bound range for efficiency
        const index = store.index('updatedAt');
        const range = IDBKeyRange.lowerBound(since);
        const req   = index.openCursor(range);
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            results.push({ key: cursor.value.key, value: cursor.value.value, updatedAt: cursor.value.updatedAt });
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = (e) => reject(e.target.error);
      } else {
        const req = store.getAll();
        req.onsuccess = (e) => {
          resolve(e.target.result.map(r => ({ key: r.key, value: r.value, updatedAt: r.updatedAt })));
        };
        req.onerror = (e) => reject(e.target.error);
      }
    });
  }

  /** @override */
  async count() {
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req   = store.count();
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /** @override */
  async clear() {
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req   = store.clear();
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  // ── Extras ───────────────────────────────────────────────────────────────────

  /**
   * Return all keys that start with a given prefix.
   * Useful for listing items by category: getByPrefix('item:')
   * @param {string} prefix
   * @returns {Promise<Array<{key:string, value:*, updatedAt:number}>>}
   */
  async getByPrefix(prefix) {
    if (!prefix) return this.getAll();
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx      = db.transaction('kv', 'readonly');
      const store   = tx.objectStore('kv');
      // IDBKeyRange from prefix to prefix + '\uffff' covers all keys with that prefix
      const range   = IDBKeyRange.bound(prefix, prefix + '\uffff');
      const req     = store.getAll(range);
      req.onsuccess = (e) => {
        resolve(e.target.result.map(r => ({ key: r.key, value: r.value, updatedAt: r.updatedAt })));
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Atomically read-modify-write a key.
   * cb receives the current value (or null) and should return the new value.
   * @param {string} key
   * @param {Function} cb  - (current: *) => * | Promise<*>
   * @returns {Promise<*>} new value
   */
  async update(key, cb) {
    if (key == null) throw new TypeError('key must not be null/undefined');
    const db = await this._ready;
    return new Promise(async (resolve, reject) => {
      try {
        const tx      = db.transaction('kv', 'readwrite');
        const store   = tx.objectStore('kv');
        const getReq  = store.get(String(key));

        getReq.onsuccess = async (e) => {
          try {
            const current  = e.target.result ? e.target.result.value : null;
            const newValue = await cb(current);
            const putReq   = store.put({ key: String(key), value: newValue, updatedAt: Date.now() });
            putReq.onsuccess = () => resolve(newValue);
            putReq.onerror   = (e2) => reject(e2.target.error);
          } catch (err) {
            reject(err);
          }
        };
        getReq.onerror = (e) => reject(e.target.error);
      } catch (err) {
        reject(err);
      }
    });
  }
}
