/**
 * Tests for Plumtree gossip protocol
 */

import { Plumtree } from '../src/gossip/plumtree.js';

function makeRouter() {
  const handlers = {};
  const sent = [];
  return {
    handle(type, fn) { handlers[type] = fn; },
    send(peerId, type, payload) { sent.push({ peerId, type, payload }); },
    broadcast(type, payload, excludePeerId) {
      sent.push({ peerId: `*!${excludePeerId}`, type, payload });
    },
    _handlers: handlers,
    _sent: sent,
    receive(fromPeerId, type, payload) {
      if (handlers[type]) handlers[type](fromPeerId, { type, ...payload });
    },
  };
}

describe('Plumtree', () => {
  describe('peer management', () => {
    test('addPeer adds to eager set', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'A' });
      pt.addPeer('B');
      expect(pt._eagerPeers.has('B')).toBe(true);
    });

    test('removePeer removes from all sets', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'A' });
      pt.addPeer('B');
      pt.removePeer('B');
      expect(pt._eagerPeers.has('B')).toBe(false);
      expect(pt._lazyPeers.has('B')).toBe(false);
    });

    test('addPeer ignores self', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'A' });
      pt.addPeer('A');
      expect(pt._eagerPeers.has('A')).toBe(false);
    });
  });

  describe('broadcast', () => {
    test('sends GOSSIP_FULL to eager peers', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'A' });
      pt.addPeer('B');
      pt.addPeer('C');
      pt.broadcast('TEST', { data: 'hello' });

      const fullMsgs = router._sent.filter(s => s.type === 'GOSSIP_FULL');
      const targets = fullMsgs.map(s => s.peerId);
      expect(targets).toContain('B');
      expect(targets).toContain('C');
    });

    test('sends GOSSIP_IHAVE to lazy peers', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'A' });
      pt.addPeer('B');
      pt._moveToLazy('B');
      pt.broadcast('TEST', { x: 1 });

      const ihaveMsgs = router._sent.filter(s => s.type === 'GOSSIP_IHAVE');
      expect(ihaveMsgs.length).toBeGreaterThan(0);
      expect(ihaveMsgs[0].peerId).toBe('B');
    });
  });

  describe('receiving GOSSIP_FULL', () => {
    test('delivers new message to application', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'B' });
      const delivered = [];
      pt.on('message', (from, msg) => delivered.push({ from, msg }));

      pt.addPeer('A');
      const msg = { id: 'msg-1', msgType: 'TEST', payload: { x: 1 }, origin: 'A' };
      router.receive('A', 'GOSSIP_FULL', { msg });

      expect(delivered).toHaveLength(1);
      expect(delivered[0].msg.id).toBe('msg-1');
    });

    test('sends GOSSIP_PRUNE on duplicate', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'B' });
      pt.addPeer('A');
      pt.addPeer('C');

      const msg = { id: 'dup-1', msgType: 'T', payload: {}, origin: 'A' };
      router.receive('A', 'GOSSIP_FULL', { msg });
      router._sent.length = 0; // reset
      router.receive('C', 'GOSSIP_FULL', { msg }); // duplicate from C

      const prune = router._sent.find(s => s.type === 'GOSSIP_PRUNE' && s.peerId === 'C');
      expect(prune).toBeDefined();
    });

    test('forwards to other eager peers', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'B' });
      pt.addPeer('A');
      pt.addPeer('C');

      const msg = { id: 'fwd-1', msgType: 'T', payload: {}, origin: 'A' };
      router.receive('A', 'GOSSIP_FULL', { msg });

      // Should forward to C (not back to A)
      const fwd = router._sent.filter(s => s.type === 'GOSSIP_FULL');
      const targets = fwd.map(s => s.peerId);
      expect(targets).toContain('C');
      expect(targets).not.toContain('A');
    });

    test('promotes sender to eager set', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'B' });
      pt._lazyPeers.add('A'); // A starts as lazy

      const eagerEvents = [];
      pt.on('peer:eager', p => eagerEvents.push(p));

      const msg = { id: 'promo-1', msgType: 'T', payload: {}, origin: 'A' };
      router.receive('A', 'GOSSIP_FULL', { msg });

      expect(pt._eagerPeers.has('A')).toBe(true);
      expect(pt._lazyPeers.has('A')).toBe(false);
      expect(eagerEvents).toContain('A');
    });
  });

  describe('IHAVE / GRAFT repair', () => {
    test('GRAFT promotes peer and sends full message', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'A', repairTimeoutMs: 50 });
      pt.addPeer('B');
      pt.broadcast('T', {});
      const msgId = pt._seen[pt._seen.length - 1];

      router._sent.length = 0;
      router.receive('B', 'GOSSIP_GRAFT', { msgId });

      const fullMsg = router._sent.find(s => s.type === 'GOSSIP_FULL' && s.peerId === 'B');
      expect(fullMsg).toBeDefined();
    });

    test('PRUNE demotes peer to lazy', () => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'A' });
      pt.addPeer('B');

      const lazyEvents = [];
      pt.on('peer:lazy', p => lazyEvents.push(p));

      router.receive('B', 'GOSSIP_PRUNE', {});

      expect(pt._lazyPeers.has('B')).toBe(true);
      expect(pt._eagerPeers.has('B')).toBe(false);
      expect(lazyEvents).toContain('B');
    });

    test('IHAVE triggers repair timer', (done) => {
      const router = makeRouter();
      const pt = new Plumtree({ router, peerId: 'A', repairTimeoutMs: 50 });
      pt.addPeer('B');
      pt._lazyPeers.add('B');
      pt._eagerPeers.delete('B');

      router.receive('B', 'GOSSIP_IHAVE', { msgId: 'unknown-msg' });

      setTimeout(() => {
        const graft = router._sent.find(s => s.type === 'GOSSIP_GRAFT');
        expect(graft).toBeDefined();
        done();
      }, 100);
    });
  });
});
