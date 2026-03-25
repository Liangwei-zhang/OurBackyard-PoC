/**
 * Tests for MerkleSync
 * Run with: node --test sdk/tests/merkle-sync.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MerkleSync } from '../src/sync/merkle-sync.js';
import { MessageRouter } from '../src/sync/message-router.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

/**
 * Create a pair of MerkleSync instances wired together.
 */
async function makeSyncPair(items1 = {}, items2 = {}) {
  const router1 = new MessageRouter();
  const router2 = new MessageRouter();
  const storage1 = new MemoryStorage();
  const storage2 = new MemoryStorage();

  for (const [k, v] of Object.entries(items1)) await storage1.put(k, v);
  for (const [k, v] of Object.entries(items2)) await storage2.put(k, v);

  const sync1 = new MerkleSync({ router: router1, storage: storage1, peerId: 'peer1', syncIntervalMs: 5000 });
  const sync2 = new MerkleSync({ router: router2, storage: storage2, peerId: 'peer2', syncIntervalMs: 5000 });

  // Wire message routing between the two
  sync1.setSendFn(async (toPeerId, msg) => {
    if (toPeerId === 'peer2') await router2.route('peer1', msg);
  });
  sync2.setSendFn(async (toPeerId, msg) => {
    if (toPeerId === 'peer1') await router1.route('peer2', msg);
  });

  return { sync1, sync2, storage1, storage2, router1, router2 };
}

describe('MerkleSync', () => {
  it('should require router, storage, and peerId', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    assert.throws(() => new MerkleSync({ storage: s, peerId: 'p1' }), /router is required/);
    assert.throws(() => new MerkleSync({ router: r, peerId: 'p1' }), /storage is required/);
    assert.throws(() => new MerkleSync({ router: r, storage: s }), /peerId is required/);
  });

  it('should build a tree from empty storage', async () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const sync = new MerkleSync({ router: r, storage: s, peerId: 'p1' });
    const tree = await sync.buildTree();
    assert.ok(tree.root);
    assert.equal(tree.leafCount, 0);
    assert.deepStrictEqual(tree.levels, []);
  });

  it('should build a tree with leaves', async () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    await s.put('item:1', { id: '1', title: 'Apple' });
    await s.put('item:2', { id: '2', title: 'Banana' });

    const sync = new MerkleSync({ router: r, storage: s, peerId: 'p1' });
    const tree = await sync.buildTree();
    assert.equal(tree.leafCount, 2);
    assert.ok(tree.root.length > 0);
    assert.equal(tree.leaves.length, 2);
  });

  it('should produce same root for same data', async () => {
    const r1 = new MessageRouter();
    const r2 = new MessageRouter();
    const s1 = new MemoryStorage();
    const s2 = new MemoryStorage();
    await s1.put('a', 1);
    await s1.put('b', 2);
    await s2.put('a', 1);
    await s2.put('b', 2);

    const sync1 = new MerkleSync({ router: r1, storage: s1, peerId: 'p1' });
    const sync2 = new MerkleSync({ router: r2, storage: s2, peerId: 'p2' });

    const tree1 = await sync1.buildTree();
    const tree2 = await sync2.buildTree();
    assert.equal(tree1.root, tree2.root, 'Same data should produce same root');
  });

  it('should produce different roots for different data', async () => {
    const r1 = new MessageRouter();
    const r2 = new MessageRouter();
    const s1 = new MemoryStorage();
    const s2 = new MemoryStorage();
    await s1.put('a', 1);
    await s2.put('a', 2); // Different value

    const sync1 = new MerkleSync({ router: r1, storage: s1, peerId: 'p1' });
    const sync2 = new MerkleSync({ router: r2, storage: s2, peerId: 'p2' });

    const tree1 = await sync1.buildTree();
    const tree2 = await sync2.buildTree();
    assert.notEqual(tree1.root, tree2.root, 'Different data should produce different roots');
  });

  it('should detect when two peers are in sync', async () => {
    const { sync1, sync2 } = await makeSyncPair({ 'item:1': 'apple' }, { 'item:1': 'apple' });

    const completed = [];
    sync1.on('sync:completed', (e) => completed.push(e));

    const result = await sync1.syncWithPeer('peer2');
    assert.ok(result.synced);
    assert.equal(result.itemsSynced, 0);
  });

  it('should sync missing items from remote peer', async () => {
    const { sync1, sync2, storage1 } = await makeSyncPair(
      {},
      { 'item:1': { id: '1', title: 'Apple' }, 'item:2': { id: '2', title: 'Banana' } }
    );

    const result = await sync1.syncWithPeer('peer2');
    assert.ok(result.synced);
    assert.ok(result.itemsSynced >= 1);

    // Verify items were synced into storage1
    const item1 = await storage1.get('item:1');
    assert.ok(item1, 'item:1 should be synced');
  });

  it('should sync changed items', async () => {
    const { sync1, sync2, storage1 } = await makeSyncPair(
      { 'item:1': { id: '1', title: 'Old Title' } },
      { 'item:1': { id: '1', title: 'New Title' } }
    );

    await sync1.syncWithPeer('peer2');
    const item = await storage1.get('item:1');
    assert.equal(item.title, 'New Title');
  });

  it('should emit sync:started and sync:completed events', async () => {
    const { sync1, sync2 } = await makeSyncPair({ 'a': 1 }, { 'a': 1 });

    const started = [];
    const completed = [];
    sync1.on('sync:started', e => started.push(e));
    sync1.on('sync:completed', e => completed.push(e));

    await sync1.syncWithPeer('peer2');

    assert.equal(started.length, 1);
    assert.equal(completed.length, 1);
  });

  it('should timeout if peer does not respond', async () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const sync = new MerkleSync({ router: r, storage: s, peerId: 'p1' });
    // Send to a peer that doesn't exist (no send fn wired)
    // syncWithPeer will timeout after 30s, so we just verify it rejects
    // Instead of waiting 30s, we'll patch the session's timeout after creation
    let rejectFn;
    const promise = sync.syncWithPeer('ghost-peer');
    
    // Force session timeout
    await new Promise(r => setTimeout(r, 10));
    for (const session of sync._sessions.values()) {
      clearTimeout(session.timeout);
      session.timeout = setTimeout(() => {
        sync._sessions.delete(session.sessionId);
        session.reject(new Error('Sync session timed out'));
      }, 10);
    }
    
    await assert.rejects(promise, /timed out/);
  });

  it('should start and stop periodic sync', async () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const sync = new MerkleSync({ router: r, storage: s, peerId: 'p1', syncIntervalMs: 100 });
    sync.startPeriodicSync(() => []);
    assert.ok(sync._intervalId !== null);
    sync.stopPeriodicSync();
    assert.equal(sync._intervalId, null);
  });

  it('should handle buildTree with since filter', async () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    await s.put('old', 'value');

    const sync = new MerkleSync({ router: r, storage: s, peerId: 'p1' });
    const tree = await sync.buildTree(Date.now() + 10000); // future timestamp
    assert.equal(tree.leafCount, 0, 'Should return empty tree for future since');
  });
});
