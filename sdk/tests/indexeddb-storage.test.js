/**
 * Tests for IndexedDBStorage
 *
 * Because Node.js doesn't have a native IndexedDB implementation we provide a
 * lightweight in-process mock that mimics the IDB cursor + transaction API.
 * The mock lives entirely in this file so there are no extra dependencies.
 *
 * Run with: node --test sdk/tests/indexeddb-storage.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, before, beforeEach } from 'node:test';

// ── Minimal IndexedDB mock ───────────────────────────────────────────────────
// Supports: open, objectStore (getAll, get, put, delete, count, clear, index/cursor-range),
// IDBKeyRange (bound, lowerBound).
// No transaction isolation needed — tests run sequentially.

function makeIDBMock() {
  const _dbs = new Map(); // dbName -> Map<storeName, Map<key, record>>

  function getStore(dbName, storeName) {
    if (!_dbs.has(dbName)) _dbs.set(dbName, new Map());
    const db = _dbs.get(dbName);
    if (!db.has(storeName)) db.set(storeName, new Map());
    return db.get(storeName);
  }

  class FakeRequest {
    constructor(fn) {
      this.result = undefined;
      this.error  = null;
      this.onsuccess = null;
      this.onerror   = null;
      Promise.resolve().then(() => {
        try {
          this.result = fn();
          this.onsuccess?.({ target: { result: this.result } });
        } catch (e) {
          this.error = e;
          this.onerror?.({ target: { error: e } });
        }
      });
    }
  }

  class FakeCursorRequest {
    constructor(records) {
      this.onsuccess = null;
      this.onerror   = null;
      const items = [...records];
      const fire = (i) => {
        Promise.resolve().then(() => {
          if (i >= items.length) {
            this.onsuccess?.({ target: { result: null } });
          } else {
            const cursor = { value: items[i], continue: () => fire(i + 1) };
            this.onsuccess?.({ target: { result: cursor } });
          }
        });
      };
      fire(0);
    }
  }

  class FakeObjectStore {
    constructor(storeMap) { this._map = storeMap; }

    _index() {
      const map = this._map;
      return {
        openCursor(range) {
          const lo = range?._lower ?? -Infinity;
          const records = [...map.values()].filter(r => r.updatedAt >= lo);
          records.sort((a, b) => a.updatedAt - b.updatedAt);
          return new FakeCursorRequest(records);
        },
      };
    }

    index(_name) { return this._index(); }

    get(key) { return new FakeRequest(() => this._map.get(key) ?? null); }
    getAll(range) {
      return new FakeRequest(() => {
        if (!range) return [...this._map.values()];
        const lo  = range._lower;
        const hi  = range._upper;
        return [...this._map.values()].filter(r => {
          const k = r.key;
          return (!lo || k >= lo) && (!hi || k <= hi);
        });
      });
    }
    put(record) {
      return new FakeRequest(() => {
        this._map.set(record.key, record);
        return record.key;
      });
    }
    delete(key) { return new FakeRequest(() => this._map.delete(key)); }
    count()     { return new FakeRequest(() => this._map.size); }
    clear()     { return new FakeRequest(() => this._map.clear()); }
  }

  class FakeTransaction {
    constructor(storeMap) { this._storeMap = storeMap; }
    objectStore(_name) { return new FakeObjectStore(this._storeMap); }
  }

  class FakeDB {
    constructor(name, storeMap) { this._name = name; this._map = storeMap; }
    transaction(_storeName, _mode) { return new FakeTransaction(this._map); }
    close() {}
    objectStoreNames = { contains: () => false };
    // Called by onupgradeneeded — the store already exists in _map via getStore()
    createObjectStore(_name, _opts) {
      return { createIndex: () => {} };
    }
  }

  const fakeIndexedDB = {
    open(dbName, _version) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      Promise.resolve().then(() => {
        const store = getStore(dbName, 'kv');
        const db    = new FakeDB(dbName, store);
        req.onupgradeneeded?.({ target: { result: db } });
        req.result = db;
        req.onsuccess?.({ target: { result: db } });
      });
      return req;
    },
    deleteDatabase(dbName) {
      const req = { onsuccess: null, onerror: null, onblocked: null };
      Promise.resolve().then(() => {
        _dbs.delete(dbName);
        req.onsuccess?.();
      });
      return req;
    },
  };

  const fakeIDBKeyRange = {
    bound:      (lo, hi)  => ({ _lower: lo, _upper: hi }),
    lowerBound: (lo)      => ({ _lower: lo, _upper: null }),
  };

  return { fakeIndexedDB, fakeIDBKeyRange };
}

// Install mock before importing the module under test
const { fakeIndexedDB, fakeIDBKeyRange } = makeIDBMock();
globalThis.indexedDB   = fakeIndexedDB;
globalThis.IDBKeyRange = fakeIDBKeyRange;

// Now import the module (it reads globalThis.indexedDB)
import { IndexedDBStorage } from '../src/storage/indexeddb-storage.js';
import { MemoryStorage }    from '../src/storage/memory-storage.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let storage;

// ── Test suites ──────────────────────────────────────────────────────────────

describe('IndexedDBStorage — basic CRUD', () => {
  before(async () => {
    storage = new IndexedDBStorage('test-basic');
    await storage._ready;
  });

  it('put() + get() roundtrip', async () => {
    await storage.put('hello', { msg: 'world' });
    const val = await storage.get('hello');
    assert.deepEqual(val, { msg: 'world' });
  });

  it('get() returns null for missing key', async () => {
    const val = await storage.get('does-not-exist');
    assert.equal(val, null);
  });

  it('put() overwrites existing key', async () => {
    await storage.put('foo', 'first');
    await storage.put('foo', 'second');
    assert.equal(await storage.get('foo'), 'second');
  });

  it('delete() removes a key', async () => {
    await storage.put('to-delete', 42);
    await storage.delete('to-delete');
    assert.equal(await storage.get('to-delete'), null);
  });

  it('delete() on missing key does not throw', async () => {
    await assert.doesNotReject(() => storage.delete('no-such-key'));
  });

  it('count() reflects stored items', async () => {
    await storage.clear();
    assert.equal(await storage.count(), 0);
    await storage.put('a', 1);
    await storage.put('b', 2);
    assert.equal(await storage.count(), 2);
  });

  it('clear() removes all items', async () => {
    await storage.put('x', 1);
    await storage.clear();
    assert.equal(await storage.count(), 0);
  });

  it('put() throws on null key', async () => {
    await assert.rejects(() => storage.put(null, 'v'), TypeError);
  });
});

describe('IndexedDBStorage — getAll()', () => {
  before(async () => {
    storage = new IndexedDBStorage('test-getall');
    await storage._ready;
    await storage.clear();
    await storage.put('item:1', { id: '1', title: 'Bike' });
    await storage.put('item:2', { id: '2', title: 'Lamp' });
    await storage.put('item:3', { id: '3', title: 'Desk' });
  });

  it('returns all records without filter', async () => {
    const all = await storage.getAll();
    assert.equal(all.length, 3);
    for (const r of all) {
      assert.ok('key' in r && 'value' in r && 'updatedAt' in r);
    }
  });

  it('returns records with updatedAt field', async () => {
    const all = await storage.getAll();
    for (const r of all) {
      assert.ok(typeof r.updatedAt === 'number' && r.updatedAt > 0);
    }
  });

  it('getAll({ since }) filters by updatedAt', async () => {
    const before = Date.now();
    await new Promise(r => setTimeout(r, 5));
    await storage.put('item:4', { id: '4', title: 'Chair' });
    const recent = await storage.getAll({ since: before + 1 });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].value.title, 'Chair');
  });

  it('getAll({ since: 0 }) returns all items', async () => {
    const all = await storage.getAll({ since: 0 });
    assert.ok(all.length >= 3);
  });
});

describe('IndexedDBStorage — getByPrefix()', () => {
  before(async () => {
    storage = new IndexedDBStorage('test-prefix');
    await storage._ready;
    await storage.clear();
    await storage.put('item:a', { title: 'A' });
    await storage.put('item:b', { title: 'B' });
    await storage.put('chat:1', { text: 'Hi' });
    await storage.put('chat:2', { text: 'Hello' });
  });

  it('returns only keys with matching prefix', async () => {
    const items = await storage.getByPrefix('item:');
    assert.equal(items.length, 2);
    for (const r of items) assert.ok(r.key.startsWith('item:'));
  });

  it('returns empty array for unmatched prefix', async () => {
    const result = await storage.getByPrefix('user:');
    assert.equal(result.length, 0);
  });

  it('getByPrefix with no arg returns all', async () => {
    const all = await storage.getByPrefix('');
    assert.ok(all.length >= 4);
  });
});

describe('IndexedDBStorage — update()', () => {
  before(async () => {
    storage = new IndexedDBStorage('test-update');
    await storage._ready;
    await storage.clear();
  });

  it('creates key if it does not exist (cb receives null)', async () => {
    const result = await storage.update('counter', (cur) => (cur ?? 0) + 1);
    assert.equal(result, 1);
    assert.equal(await storage.get('counter'), 1);
  });

  it('reads current value before writing', async () => {
    await storage.put('n', 10);
    const result = await storage.update('n', (cur) => cur * 2);
    assert.equal(result, 20);
    assert.equal(await storage.get('n'), 20);
  });

  it('throws TypeError on null key', async () => {
    await assert.rejects(() => storage.update(null, x => x), TypeError);
  });
});

describe('IndexedDBStorage — destroy()', () => {
  it('deletes the database', async () => {
    const s = new IndexedDBStorage('test-destroy');
    await s._ready;
    await s.put('key', 'value');
    await s.destroy();
    // After destroy a new instance of the same db should start empty
    const s2 = new IndexedDBStorage('test-destroy');
    await s2._ready;
    assert.equal(await s2.count(), 0);
  });
});

describe('IndexedDBStorage — IStorage contract compliance', () => {
  it('implements the same interface as MemoryStorage', () => {
    const idb = new IndexedDBStorage('test-contract');
    const mem = new MemoryStorage();
    const methods = ['put', 'get', 'delete', 'getAll', 'count', 'clear'];
    for (const m of methods) {
      assert.equal(typeof idb[m], 'function', `IndexedDBStorage missing method: ${m}`);
      assert.equal(typeof mem[m], 'function', `MemoryStorage missing method: ${m}`);
    }
  });

  it('IStorage extra methods are present on IndexedDBStorage', () => {
    const idb = new IndexedDBStorage('test-extras');
    assert.equal(typeof idb.getByPrefix, 'function');
    assert.equal(typeof idb.update,      'function');
    assert.equal(typeof idb.destroy,     'function');
    assert.equal(typeof idb.close,       'function');
  });
});
