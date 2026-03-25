/**
 * Tests for CRDT implementations: LWWRegister, ORSet, GCounter, CRDTManager
 * Run with: node --test sdk/tests/crdt.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { LWWRegister, ORSet, GCounter, CRDTManager } from '../src/sync/crdt.js';
import { MessageRouter } from '../src/sync/message-router.js';

// ── LWWRegister ───────────────────────────────────────────────────────────────

describe('LWWRegister', () => {
  it('should set and get a value', () => {
    const reg = new LWWRegister('peer1');
    reg.set('hello');
    assert.equal(reg.value, 'hello');
    assert.equal(reg.writerId, 'peer1');
    assert.ok(reg.timestamp > 0);
  });

  it('should require peerId in constructor', () => {
    assert.throws(() => new LWWRegister(), /peerId is required/);
    assert.throws(() => new LWWRegister(''), /peerId is required/);
  });

  it('should merge: higher timestamp wins', () => {
    const reg = new LWWRegister('peer1');
    reg.set('local');
    const localTs = reg.timestamp;

    reg.merge({ value: 'remote', timestamp: localTs + 1000, writerId: 'peer2' });
    assert.equal(reg.value, 'remote');
    assert.equal(reg.writerId, 'peer2');
  });

  it('should merge: lower timestamp loses', () => {
    const reg = new LWWRegister('peer1');
    reg.set('local');
    const localTs = reg.timestamp;

    reg.merge({ value: 'old', timestamp: localTs - 1000, writerId: 'peer2' });
    assert.equal(reg.value, 'local');
    assert.equal(reg.writerId, 'peer1');
  });

  it('should merge: tie-break by writerId (lexicographically larger wins)', () => {
    const reg = new LWWRegister('peer1');
    const ts = Date.now();
    reg._value = 'from-peer1';
    reg._timestamp = ts;
    reg._writerId = 'peer1';

    reg.merge({ value: 'from-peer2', timestamp: ts, writerId: 'peer2' });
    assert.equal(reg.value, 'from-peer2');
    assert.equal(reg.writerId, 'peer2');
  });

  it('should not change on tie-break if local writerId is larger', () => {
    const reg = new LWWRegister('peer9');
    const ts = Date.now();
    reg._value = 'from-peer9';
    reg._timestamp = ts;
    reg._writerId = 'peer9';

    reg.merge({ value: 'from-peer1', timestamp: ts, writerId: 'peer1' });
    assert.equal(reg.value, 'from-peer9');
  });

  it('should serialize and deserialize', () => {
    const reg = new LWWRegister('peer1');
    reg.set(42);
    const json = reg.toJSON();
    assert.equal(json.value, 42);
    assert.ok(json.timestamp > 0);

    const reg2 = LWWRegister.fromJSON('peer2', json);
    assert.equal(reg2.value, 42);
    assert.equal(reg2.writerId, 'peer1');
  });

  it('should handle null/undefined remote in merge gracefully', () => {
    const reg = new LWWRegister('peer1');
    reg.set('original');
    reg.merge(null);
    reg.merge(undefined);
    assert.equal(reg.value, 'original');
  });
});

// ── ORSet ─────────────────────────────────────────────────────────────────────

describe('ORSet', () => {
  it('should add and check elements', () => {
    const s = new ORSet('peer1');
    s.add('apple');
    assert.ok(s.has('apple'));
    assert.ok(!s.has('banana'));
  });

  it('should require peerId in constructor', () => {
    assert.throws(() => new ORSet(), /peerId is required/);
  });

  it('should remove elements', () => {
    const s = new ORSet('peer1');
    s.add('apple');
    s.remove('apple');
    assert.ok(!s.has('apple'));
  });

  it('should support add-wins for concurrent add+remove', () => {
    const s1 = new ORSet('peer1');
    const s2 = new ORSet('peer2');

    s1.add('apple');              // peer1 adds apple with tag1
    s2.add('apple');              // peer2 adds apple with tag2
    s2.remove('apple');           // peer2 removes apple (only removes tag2)

    // Merge: s1 has tag1 (alive), s2 has tag2 (tombstoned)
    s1.merge(s2.toJSON());
    // tag1 is still alive in s1 → apple is present
    assert.ok(s1.has('apple'), 'add-wins: concurrent add should survive remove');
  });

  it('should return all present values', () => {
    const s = new ORSet('peer1');
    s.add('apple');
    s.add('banana');
    s.add('cherry');
    s.remove('banana');
    const vals = s.values();
    assert.ok(vals.includes('apple'));
    assert.ok(!vals.includes('banana'));
    assert.ok(vals.includes('cherry'));
  });

  it('should merge convergently (commutativity)', () => {
    const s1 = new ORSet('peer1');
    const s2 = new ORSet('peer2');
    s1.add('apple');
    s2.add('banana');

    const s3 = ORSet.fromJSON('peer3', s1.toJSON());
    s3.merge(s2.toJSON());

    const s4 = ORSet.fromJSON('peer4', s2.toJSON());
    s4.merge(s1.toJSON());

    // s3 and s4 should have the same elements
    assert.deepStrictEqual(s3.values().sort(), s4.values().sort());
  });

  it('should be idempotent on repeated merges', () => {
    const s1 = new ORSet('peer1');
    s1.add('apple');
    const json = s1.toJSON();

    const s2 = new ORSet('peer2');
    s2.merge(json);
    s2.merge(json);
    s2.merge(json);

    assert.ok(s2.has('apple'));
    assert.equal(s2.values().length, 1);
  });

  it('should serialize and deserialize', () => {
    const s = new ORSet('peer1');
    s.add('x');
    s.add('y');
    s.remove('x');
    const json = s.toJSON();
    const s2 = ORSet.fromJSON('peer2', json);
    assert.ok(!s2.has('x'));
    assert.ok(s2.has('y'));
  });

  it('should throw on null element add', () => {
    const s = new ORSet('peer1');
    assert.throws(() => s.add(null), /element must not be null/);
  });
});

// ── GCounter ──────────────────────────────────────────────────────────────────

describe('GCounter', () => {
  it('should start at zero', () => {
    const c = new GCounter('peer1');
    assert.equal(c.value, 0);
  });

  it('should require peerId', () => {
    assert.throws(() => new GCounter(), /peerId is required/);
  });

  it('should increment own slot', () => {
    const c = new GCounter('peer1');
    c.increment();
    assert.equal(c.value, 1);
    c.increment(4);
    assert.equal(c.value, 5);
  });

  it('should reject non-positive increment amounts', () => {
    const c = new GCounter('peer1');
    assert.throws(() => c.increment(0), /positive number/);
    assert.throws(() => c.increment(-1), /positive number/);
  });

  it('should merge by taking max per peer', () => {
    const c1 = new GCounter('peer1');
    c1.increment(3);

    const c2 = new GCounter('peer2');
    c2.increment(5);

    c1.merge(c2.toJSON());
    assert.equal(c1.value, 8); // 3 (peer1) + 5 (peer2)
  });

  it('should not decrease on merge', () => {
    const c1 = new GCounter('peer1');
    c1.increment(10);

    const c2 = new GCounter('peer1');
    c2.increment(2); // Lower than c1's local count

    c1.merge(c2.toJSON());
    assert.equal(c1.getCount('peer1'), 10); // max(10, 2) = 10
  });

  it('should be commutative', () => {
    const c1 = new GCounter('peer1');
    c1.increment(3);
    const c2 = new GCounter('peer2');
    c2.increment(7);

    const merged1 = GCounter.fromJSON('x', c1.toJSON());
    merged1.merge(c2.toJSON());

    const merged2 = GCounter.fromJSON('x', c2.toJSON());
    merged2.merge(c1.toJSON());

    assert.equal(merged1.value, merged2.value);
  });

  it('should serialize and deserialize', () => {
    const c = new GCounter('peer1');
    c.increment(42);
    const json = c.toJSON();
    const c2 = GCounter.fromJSON('peer2', json);
    assert.equal(c2.value, 42);
  });
});

// ── CRDTManager ───────────────────────────────────────────────────────────────

describe('CRDTManager', () => {
  it('should create and return named CRDTs', () => {
    const router = new MessageRouter();
    const mgr = new CRDTManager({ router, peerId: 'peer1' });

    const reg = mgr.lwwRegister('status');
    assert.ok(reg instanceof LWWRegister);

    const set = mgr.orSet('favorites');
    assert.ok(set instanceof ORSet);

    const cnt = mgr.gCounter('views');
    assert.ok(cnt instanceof GCounter);
  });

  it('should return same instance on repeated calls', () => {
    const router = new MessageRouter();
    const mgr = new CRDTManager({ router, peerId: 'peer1' });
    assert.strictEqual(mgr.lwwRegister('x'), mgr.lwwRegister('x'));
  });

  it('should require router and peerId', () => {
    assert.throws(() => new CRDTManager({ peerId: 'p1' }), /router is required/);
    assert.throws(() => new CRDTManager({ router: new MessageRouter() }), /peerId is required/);
  });

  it('should handle incoming CRDT_UPDATE message for LWW', async () => {
    const router = new MessageRouter();
    const mgr = new CRDTManager({ router, peerId: 'peer1' });

    const merged = [];
    mgr.on('crdt:merged', (data) => merged.push(data));

    const ts = Date.now() + 1000;
    await router.route('remote', {
      type: 'CRDT_UPDATE',
      id: 'x1',
      name: 'status',
      crdtType: 'lww',
      state: { value: 'sold', timestamp: ts, writerId: 'remote' },
    });

    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, 'status');
    const reg = mgr.lwwRegister('status');
    assert.equal(reg.value, 'sold');
  });

  it('should handle incoming CRDT_UPDATE for ORSet', async () => {
    const router = new MessageRouter();
    const mgr = new CRDTManager({ router, peerId: 'peer1' });

    await router.route('remote', {
      type: 'CRDT_UPDATE',
      id: 'x2',
      name: 'favorites',
      crdtType: 'orset',
      state: {
        elements: [{ element: 'item42', tags: ['remote:1'] }],
        tombstones: [],
      },
    });

    const set = mgr.orSet('favorites');
    assert.ok(set.has('item42'));
  });

  it('should handle incoming CRDT_UPDATE for GCounter', async () => {
    const router = new MessageRouter();
    const mgr = new CRDTManager({ router, peerId: 'peer1' });

    await router.route('remote', {
      type: 'CRDT_UPDATE',
      id: 'x3',
      name: 'views:item1',
      crdtType: 'gcounter',
      state: { counts: [{ peerId: 'remote', count: 100 }] },
    });

    const cnt = mgr.gCounter('views:item1');
    assert.equal(cnt.getCount('remote'), 100);
  });
});
