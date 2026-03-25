/**
 * Tests for MerkleSync
 */

import { MerkleSync } from '../src/sync/merkle-sync.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

// Polyfill crypto.subtle for Node.js < 19 test environments
import { webcrypto } from 'node:crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

function makeRouter() {
  const handlers = {};
  const sent = [];
  return {
    handle(type, fn) { handlers[type] = fn; },
    send(peerId, type, payload) { sent.push({ peerId, type, payload }); },
    broadcast(type, payload) { sent.push({ peerId: '*', type, payload }); },
    _handlers: handlers,
    _sent: sent,
    receive(fromPeerId, type, payload) {
      if (handlers[type]) handlers[type](fromPeerId, { type, ...payload });
    },
  };
}

async function addItem(storage, sellerId, title, timestamp) {
  await storage.addItem({ sellerId, title, timestamp, status: 'active' });
}

describe('MerkleSync', () => {
  test('getSyncStatus returns initial empty state', async () => {
    const storage = new MemoryStorage();
    const router = makeRouter();
    const sync = new MerkleSync({ router, storage, peerId: 'A' });
    await sync.rebuild();
    const status = sync.getSyncStatus();
    expect(status.totalItems).toBe(0);
    expect(status.rootHash).toBe('');
  });

  test('rebuild populates tree from storage', async () => {
    const storage = new MemoryStorage();
    await addItem(storage, 'seller1', 'Item A', 1000);
    await addItem(storage, 'seller1', 'Item B', 2000);

    const router = makeRouter();
    const sync = new MerkleSync({ router, storage, peerId: 'A' });
    await sync.rebuild();

    const status = sync.getSyncStatus();
    expect(status.totalItems).toBe(2);
    expect(status.rootHash).not.toBe('');
  });

  test('syncWith sends MERKLE_ROOT', async () => {
    const storage = new MemoryStorage();
    const router = makeRouter();
    const sync = new MerkleSync({ router, storage, peerId: 'A' });

    // Resolve the sync immediately by simulating matching roots
    setTimeout(() => {
      const rootMsg = router._sent.find(s => s.type === 'MERKLE_ROOT');
      // Simulate peer responding with same root hash (trees match)
      router.receive('B', 'MERKLE_ROOT', {
        rootHash: rootMsg?.payload?.rootHash || '',
        leafCount: 0,
      });
    }, 0);

    await sync.syncWith('B');

    const rootMsg = router._sent.find(s => s.type === 'MERKLE_ROOT');
    expect(rootMsg).toBeDefined();
    expect(rootMsg.peerId).toBe('B');
  });

  test('sync:complete fires when roots match', async () => {
    const storage = new MemoryStorage();
    const router = makeRouter();
    const sync = new MerkleSync({ router, storage, peerId: 'A' });

    const events = [];
    sync.on('sync:complete', (peerId, result) => events.push({ peerId, result }));

    setTimeout(() => {
      const rootMsg = router._sent.find(s => s.type === 'MERKLE_ROOT');
      router.receive('B', 'MERKLE_ROOT', {
        rootHash: rootMsg?.payload?.rootHash || '',
        leafCount: 0,
      });
    }, 0);

    const result = await sync.syncWith('B');
    expect(result.itemsSent).toBe(0);
    expect(result.itemsReceived).toBe(0);
    expect(events).toHaveLength(1);
  });

  test('sync:start fires when syncWith is called', async () => {
    const storage = new MemoryStorage();
    const router = makeRouter();
    const sync = new MerkleSync({ router, storage, peerId: 'A' });

    const started = [];
    sync.on('sync:start', (p) => started.push(p));

    setTimeout(() => {
      const rootMsg = router._sent.find(s => s.type === 'MERKLE_ROOT');
      router.receive('B', 'MERKLE_ROOT', {
        rootHash: rootMsg?.payload?.rootHash || '',
        leafCount: 0,
      });
    }, 0);

    await sync.syncWith('B');
    expect(started).toContain('B');
  });

  test('responds to MERKLE_ROOT when not initiating', async () => {
    const storage = new MemoryStorage();
    const router = makeRouter();
    const sync = new MerkleSync({ router, storage, peerId: 'A' });
    await sync.rebuild();

    // Receive a root from peer without having called syncWith
    router.receive('B', 'MERKLE_ROOT', { rootHash: 'some-hash', leafCount: 5 });

    // Wait for async rebuild + send inside the handler
    await new Promise(r => setTimeout(r, 50));

    // Should respond with our own root
    const response = router._sent.find(s => s.type === 'MERKLE_ROOT' && s.peerId === 'B');
    expect(response).toBeDefined();
  });
});
