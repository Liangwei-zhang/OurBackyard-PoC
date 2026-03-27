/**
 * Tests for MemoryStorage — in-memory IStorage implementation.
 * Run with: node --test sdk/tests/memory-storage.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { MemoryStorage } from '../src/storage/memory-storage.js';

describe('MemoryStorage — put / get', () => {
  let s;
  beforeEach(() => { s = new MemoryStorage(); });

  it('put() then get() returns the stored value', async () => {
    await s.put('k1', { id: 'item1', title: 'Lamp' });
    const v = await s.get('k1');
    assert.deepEqual(v, { id: 'item1', title: 'Lamp' });
  });

  it('get() returns null for missing key', async () => {
    const v = await s.get('nonexistent');
    assert.equal(v, null);
  });

  it('put() overwrites existing value', async () => {
    await s.put('key', 'first');
    await s.put('key', 'second');
    assert.equal(await s.get('key'), 'second');
  });

  it('put() coerces numeric key to string', async () => {
    await s.put(42, 'value');
    assert.equal(await s.get('42'), 'value');
  });

  it('put() throws on null key', async () => {
    await assert.rejects(() => s.put(null, 'v'), /key must not be null\/undefined/);
  });

  it('put() throws on undefined key', async () => {
    await assert.rejects(() => s.put(undefined, 'v'), /key must not be null\/undefined/);
  });

  it('stores any JSON-serialisable value type', async () => {
    await s.put('num',   42);
    await s.put('bool',  false);
    await s.put('arr',   [1, 2, 3]);
    await s.put('null',  null);
    assert.equal(await s.get('num'),  42);
    assert.equal(await s.get('bool'), false);
    assert.deepEqual(await s.get('arr'), [1, 2, 3]);
    assert.equal(await s.get('null'), null);
  });
});

describe('MemoryStorage — delete', () => {
  let s;
  beforeEach(() => { s = new MemoryStorage(); });

  it('delete() removes an existing key', async () => {
    await s.put('key', 'val');
    await s.delete('key');
    assert.equal(await s.get('key'), null);
  });

  it('delete() on missing key is a no-op', async () => {
    await assert.doesNotReject(() => s.delete('nobody'));
  });
});

describe('MemoryStorage — count', () => {
  let s;
  beforeEach(() => { s = new MemoryStorage(); });

  it('count() returns 0 for empty store', async () => {
    assert.equal(await s.count(), 0);
  });

  it('count() reflects number of stored keys', async () => {
    await s.put('a', 1);
    await s.put('b', 2);
    await s.put('c', 3);
    assert.equal(await s.count(), 3);
  });

  it('count() decrements after delete', async () => {
    await s.put('a', 1);
    await s.put('b', 2);
    await s.delete('a');
    assert.equal(await s.count(), 1);
  });
});

describe('MemoryStorage — getAll', () => {
  let s;
  beforeEach(() => { s = new MemoryStorage(); });

  it('getAll() returns all entries', async () => {
    await s.put('x', 10);
    await s.put('y', 20);
    const all = await s.getAll();
    assert.equal(all.length, 2);
    const keys = all.map(e => e.key).sort();
    assert.deepEqual(keys, ['x', 'y']);
  });

  it('each entry has key, value, updatedAt', async () => {
    await s.put('k', 'v');
    const all = await s.getAll();
    assert.ok(all[0].key);
    assert.ok(all[0].value !== undefined);
    assert.ok(typeof all[0].updatedAt === 'number');
  });

  it('getAll({ since }) filters by updatedAt', async () => {
    await s.put('old', 'data');
    const midpoint = Date.now();
    await new Promise(r => setTimeout(r, 5));
    await s.put('new', 'data2');

    const recent = await s.getAll({ since: midpoint + 1 });
    const keys = recent.map(e => e.key);
    assert.ok(!keys.includes('old'), '"old" should be filtered out');
    assert.ok(keys.includes('new'),  '"new" should be included');
  });

  it('getAll() on empty store returns []', async () => {
    const all = await s.getAll();
    assert.deepEqual(all, []);
  });
});

describe('MemoryStorage — clear', () => {
  let s;
  beforeEach(() => { s = new MemoryStorage(); });

  it('clear() removes all entries', async () => {
    await s.put('a', 1);
    await s.put('b', 2);
    await s.clear();
    assert.equal(await s.count(), 0);
    assert.equal(await s.get('a'), null);
  });

  it('clear() on empty store is a no-op', async () => {
    await assert.doesNotReject(() => s.clear());
  });

  it('store is usable after clear()', async () => {
    await s.put('a', 1);
    await s.clear();
    await s.put('b', 2);
    assert.equal(await s.count(), 1);
    assert.equal(await s.get('b'), 2);
  });
});
