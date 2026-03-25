/**
 * Tests for GossipSync (integration: Plumtree + Merkle + CRDT)
 * Run with: node --test sdk/tests/gossip-sync.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GossipSync } from '../src/sync/gossip-sync.js';
import { MessageRouter } from '../src/sync/message-router.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

function makePair() {
  const router1 = new MessageRouter();
  const router2 = new MessageRouter();
  const storage1 = new MemoryStorage();
  const storage2 = new MemoryStorage();

  const gs1 = new GossipSync({ router: router1, storage: storage1, peerId: 'peer1' });
  const gs2 = new GossipSync({ router: router2, storage: storage2, peerId: 'peer2' });

  // Wire messaging
  gs1.setSendFn(async (toPeerId, msg) => {
    if (toPeerId === 'peer2') await router2.route('peer1', msg);
  });
  gs2.setSendFn(async (toPeerId, msg) => {
    if (toPeerId === 'peer1') await router1.route('peer2', msg);
  });

  gs1.addPeer('peer2');
  gs2.addPeer('peer1');

  return { gs1, gs2, storage1, storage2 };
}

describe('GossipSync', () => {
  it('should require router, storage, peerId', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    assert.throws(() => new GossipSync({ storage: s, peerId: 'p1' }), /router is required/);
    assert.throws(() => new GossipSync({ router: r, peerId: 'p1' }), /storage is required/);
    assert.throws(() => new GossipSync({ router: r, storage: s }), /peerId is required/);
  });

  it('should publish and receive an item', async () => {
    const { gs1, gs2 } = makePair();

    const received = [];
    gs2.on('item:received', (e) => received.push(e));

    await gs1.publishItem({ id: 'item1', title: 'Used Bike', price: 100 });

    await new Promise(r => setTimeout(r, 50));
    assert.ok(received.length >= 1, 'peer2 should receive the item');
    const item = received.find(e => e.payload?.id === 'item1');
    assert.ok(item, 'item1 should be received');
  });

  it('should store item in local storage on publish', async () => {
    const { gs1, storage1 } = makePair();
    await gs1.publishItem({ id: 'item2', title: 'Lamp', price: 20 });
    const stored = await storage1.get('item:item2');
    assert.ok(stored);
    assert.equal(stored.title, 'Lamp');
  });

  it('should throw on publishItem without id', async () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'p1' });
    await assert.rejects(() => gs.publishItem({}), /item must have an id/);
    await assert.rejects(() => gs.publishItem(null), /item must have an id/);
  });

  it('should update item status using LWW-Register', async () => {
    const { gs1, storage1 } = makePair();
    await gs1.publishItem({ id: 'item3', title: 'Chair', price: 50, status: 'available' });
    await gs1.updateItemStatus('item3', 'sold');
    const stored = await storage1.get('item:item3');
    assert.equal(stored.status, 'sold');
  });

  it('should add/remove/query favorites using ORSet', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'peer1' });

    gs.addFavorite('user1', 'item1');
    gs.addFavorite('user1', 'item2');
    assert.ok(gs.getFavorites('user1').includes('item1'));
    assert.ok(gs.getFavorites('user1').includes('item2'));

    gs.removeFavorite('user1', 'item1');
    assert.ok(!gs.getFavorites('user1').includes('item1'));
    assert.ok(gs.getFavorites('user1').includes('item2'));
  });

  it('should throw on invalid addFavorite args', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'peer1' });
    assert.throws(() => gs.addFavorite(null, 'item1'), /required/);
    assert.throws(() => gs.addFavorite('user1', null), /required/);
  });

  it('should track view counts using GCounter', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'peer1' });

    gs.recordView('item1');
    gs.recordView('item1');
    gs.recordView('item1', 3);
    assert.equal(gs.getViewCount('item1'), 5);
  });

  it('should throw on invalid recordView', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'peer1' });
    assert.throws(() => gs.recordView(null), /itemId is required/);
  });

  it('should add and remove peers', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'peer1' });

    const added = [];
    const removed = [];
    gs.on('peer:added', e => added.push(e.peerId));
    gs.on('peer:removed', e => removed.push(e.peerId));

    gs.addPeer('peer2');
    gs.removePeer('peer2');

    assert.ok(added.includes('peer2'));
    assert.ok(removed.includes('peer2'));
  });

  it('should not add self as peer', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'peer1' });
    const added = [];
    gs.on('peer:added', e => added.push(e.peerId));
    gs.addPeer('peer1');
    assert.equal(added.length, 0);
  });

  it('should sync items between two peers via MerkleSync', async () => {
    const { gs1, gs2, storage1, storage2 } = makePair();

    // gs2 has an item that gs1 doesn't
    await storage2.put('item:remote1', { id: 'remote1', title: 'Remote Item' });

    const result = await gs1.syncWithPeer('peer2');
    assert.ok(result.synced);

    const synced = await storage1.get('item:remote1');
    assert.ok(synced, 'item should be synced to gs1');
    assert.equal(synced.title, 'Remote Item');
  });

  it('should start and stop periodic sync', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'peer1' });
    gs.startSync(() => []);
    // merkle should have interval set
    assert.ok(gs._merkle._intervalId !== null);
    gs.stopSync();
    assert.equal(gs._merkle._intervalId, null);
  });

  it('should destroy all sub-components', () => {
    const r = new MessageRouter();
    const s = new MemoryStorage();
    const gs = new GossipSync({ router: r, storage: s, peerId: 'peer1' });
    gs.startSync(() => []);
    gs.destroy();
    assert.equal(gs._merkle._intervalId, null);
  });
});
