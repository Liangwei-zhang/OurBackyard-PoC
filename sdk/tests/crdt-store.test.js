/**
 * Tests for CRDTStore
 */

import { CRDTStore } from '../src/crdt/crdt-store.js';

/**
 * Creates a mock MessageRouter for testing.
 */
function makeRouter() {
  const handlers = {};
  const sent = [];
  return {
    handle(type, fn) { handlers[type] = fn; },
    send(peerId, type, payload) { sent.push({ peerId, type, payload }); },
    broadcast(type, payload) { sent.push({ peerId: '*', type, payload }); },
    _handlers: handlers,
    _sent: sent,
    // Helper: simulate receiving a message from a peer
    receive(fromPeerId, type, payload) {
      if (handlers[type]) handlers[type](fromPeerId, { type, ...payload });
    },
  };
}

describe('CRDTStore', () => {
  describe('register', () => {
    test('registers a new lww-register document', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('doc1', 'lww-register');
      expect(store.get('doc1')).toBeDefined();
    });

    test('register is idempotent', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('doc1', 'lww-register');
      const first = store.get('doc1');
      store.register('doc1', 'lww-register');
      expect(store.get('doc1')).toEqual(first);
    });

    test('registers a g-counter', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('counter', 'g-counter');
      expect(store.get('counter')).toEqual({ counts: { A: 0 } });
    });

    test('registers an or-set', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('tags', 'or-set');
      expect(store.get('tags')).toBeDefined();
    });
  });

  describe('apply', () => {
    test('apply sets lww-register value', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('title', 'lww-register');
      store.apply('title', 'Hello World');
      expect(store.get('title').value).toBe('Hello World');
    });

    test('apply increments g-counter', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('views', 'g-counter');
      store.apply('views', 5);
      expect(store.get('views').counts.A).toBe(5);
    });

    test('apply adds to or-set', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('tags', 'or-set');
      store.apply('tags', { op: 'add', element: 'sports' });
      const state = store.get('tags');
      expect(Object.keys(state.entries).includes('sports')).toBe(true);
    });

    test('apply broadcasts the state', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('doc', 'lww-register');
      store.apply('doc', 'value');
      const broadcast = router._sent.find(s => s.type === 'CRDT_OP');
      expect(broadcast).toBeDefined();
      expect(broadcast.payload.docId).toBe('doc');
    });

    test('apply emits update event', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('doc', 'lww-register');
      const updates = [];
      store.on('update', (docId, state) => updates.push({ docId, state }));
      store.apply('doc', 'xyz');
      expect(updates).toHaveLength(1);
      expect(updates[0].docId).toBe('doc');
    });

    test('apply throws for unknown document', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      expect(() => store.apply('missing', 'value')).toThrow();
    });
  });

  describe('remote merge via CRDT_OP', () => {
    test('merges incoming lww-register update', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('title', 'lww-register', { peerId: 'A', value: 'old', timestamp: 1 });

      const remoteState = { peerId: 'B', value: 'new-value', timestamp: Date.now() + 1000 };
      router.receive('B', 'CRDT_OP', { docId: 'title', type: 'lww-register', state: remoteState });

      expect(store.get('title').value).toBe('new-value');
    });

    test('auto-registers document on first remote update', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      expect(store.get('newdoc')).toBeNull();

      router.receive('B', 'CRDT_OP', {
        docId: 'newdoc',
        type: 'lww-register',
        state: { peerId: 'B', value: 'hello', timestamp: Date.now() },
      });

      expect(store.get('newdoc')).toBeDefined();
    });
  });

  describe('syncWith', () => {
    test('sends snapshot to peer', () => {
      const router = makeRouter();
      const store = new CRDTStore({ router, peerId: 'A' });
      store.register('doc', 'lww-register');
      store.syncWith('peer-B');

      const syncMsg = router._sent.find(s => s.type === 'CRDT_SYNC');
      expect(syncMsg).toBeDefined();
      expect(syncMsg.peerId).toBe('peer-B');
      expect(syncMsg.payload.snapshot.doc).toBeDefined();
    });
  });
});
