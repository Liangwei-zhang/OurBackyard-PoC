/**
 * Tests for enhanced BlobTransfer
 */

import { BlobTransfer } from '../src/sync/blob-transfer.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

// Polyfill for Node.js test environment
import { webcrypto } from 'node:crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

// Minimal Blob polyfill for Node.js
if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = class Blob {
    constructor(parts = [], opts = {}) {
      this._parts = parts;
      this.type = opts.type || '';
    }
    async arrayBuffer() {
      const bufs = this._parts.map(p => {
        if (p instanceof ArrayBuffer) return p;
        if (p instanceof Uint8Array) return p.buffer;
        return new TextEncoder().encode(String(p)).buffer;
      });
      const total = bufs.reduce((s, b) => s + b.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const b of bufs) {
        out.set(new Uint8Array(b), offset);
        offset += b.byteLength;
      }
      return out.buffer;
    }
  };
}

function makeRouter(storage) {
  const handlers = {};
  const sent = [];
  return {
    handle(type, fn) { handlers[type] = fn; },
    send(peerId, type, payload) { sent.push({ peerId, type, payload }); },
    broadcast(type, payload) { sent.push({ peerId: '*', type, payload }); },
    _transport: {
      getDataChannel(peerId) {
        return {
          readyState: 'open',
          bufferedAmount: 0,
          send(data) { /* no-op */ },
        };
      },
    },
    _handlers: handlers,
    _sent: sent,
    receive(fromPeerId, type, payload) {
      if (handlers[type]) handlers[type](fromPeerId, { type, ...payload });
    },
    receiveBinary(fromPeerId, ab) {
      if (handlers['binary']) handlers['binary'](fromPeerId, ab);
    },
  };
}

describe('BlobTransfer', () => {
  test('requestBlobs sends BLOB_REQ', () => {
    const storage = new MemoryStorage();
    const router = makeRouter(storage);
    const bt = new BlobTransfer({ router, storage });
    bt.requestBlobs('peer-B', ['hash1', 'hash2']);
    const req = router._sent.find(s => s.type === 'BLOB_REQ');
    expect(req).toBeDefined();
    expect(req.payload.hashes).toContain('hash1');
  });

  test('requestBlobs batches to BLOB_BATCH_LIMIT', () => {
    const storage = new MemoryStorage();
    const router = makeRouter(storage);
    const bt = new BlobTransfer({ router, storage });
    const hashes = Array.from({ length: 50 }, (_, i) => `hash${i}`);
    bt.requestBlobs('peer-B', hashes);
    const req = router._sent.find(s => s.type === 'BLOB_REQ');
    expect(req.payload.hashes.length).toBeLessThanOrEqual(30);
  });

  test('cancel removes from queue', () => {
    const storage = new MemoryStorage();
    const router = makeRouter(storage);
    const bt = new BlobTransfer({ router, storage, queueConcurrency: 0 }); // prevent auto-drain
    bt._sendQueue.push({ peerId: 'B', hash: 'test-hash', blob: new Blob(['x']), meta: {}, retries: 0 });
    bt.cancel('test-hash');
    expect(bt._sendQueue.find(e => e.hash === 'test-hash')).toBeUndefined();
    expect(bt._cancelled.has('test-hash')).toBe(true);
  });

  test('cancel emits blob:cancelled for active receive stream', () => {
    const storage = new MemoryStorage();
    const router = makeRouter(storage);
    const bt = new BlobTransfer({ router, storage });

    const cancelled = [];
    bt.on('blob:cancelled', h => cancelled.push(h));

    // Simulate a stream in progress
    bt._streams.set('peer-B:myHash', {
      hash: 'myHash', mime: 'image/jpeg', total: 10, size: 100,
      chunks: [], received: 5, startTime: Date.now(),
    });

    bt.cancel('myHash');
    expect(cancelled).toContain('myHash');
    expect(bt._streams.has('peer-B:myHash')).toBe(false);
  });

  test('_handleBlobStreamStart initializes stream state', () => {
    const storage = new MemoryStorage();
    const router = makeRouter(storage);
    const bt = new BlobTransfer({ router, storage });

    router.receive('peer-A', 'BLOB_STREAM_START', {
      hash: 'abc123',
      mime: 'image/png',
      total: 3,
      size: 192000,
      itemId: 'item-1',
    });

    const state = bt._streams.get('peer-A:abc123');
    expect(state).toBeDefined();
    expect(state.total).toBe(3);
    expect(state.mime).toBe('image/png');
  });

  test('_routeBinaryChunk tracks received chunks', () => {
    const storage = new MemoryStorage();
    const router = makeRouter(storage);
    const bt = new BlobTransfer({ router, storage });

    bt._streams.set('peer-A:hashXYZ', {
      hash: 'hashXYZ', mime: 'image/jpeg', total: 2, size: 200,
      chunks: [], received: 0, startTime: Date.now(),
    });

    const ab1 = new ArrayBuffer(100);
    const ab2 = new ArrayBuffer(100);
    router.receiveBinary('peer-A', ab1);
    router.receiveBinary('peer-A', ab2);

    const state = bt._streams.get('peer-A:hashXYZ');
    expect(state.received).toBe(2);
    expect(state.chunks.length).toBe(2);
  });

  test('progress events include percent and direction', () => {
    const storage = new MemoryStorage();
    const router = makeRouter(storage);
    const bt = new BlobTransfer({ router, storage });

    const progressEvents = [];
    bt.on('blob:progress', (hash, info) => progressEvents.push({ hash, info }));

    bt._streams.set('peer-A:hashABC', {
      hash: 'hashABC', mime: 'image/jpeg', total: 4, size: 400,
      chunks: [], received: 0, startTime: Date.now(),
    });

    router.receiveBinary('peer-A', new ArrayBuffer(100));

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].hash).toBe('hashABC');
    expect(progressEvents[0].info.percent).toBe(25);
    expect(progressEvents[0].info.direction).toBe('receive');
  });
});
