/**
 * Tests for PlumtreeGossip
 * Run with: node --test sdk/tests/plumtree-gossip.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { PlumtreeGossip } from '../src/sync/plumtree-gossip.js';
import { MessageRouter } from '../src/sync/message-router.js';

/**
 * Create a test harness: two PlumtreeGossip instances connected via message routers.
 */
function makePair(opts1 = {}, opts2 = {}) {
  const router1 = new MessageRouter();
  const router2 = new MessageRouter();

  const p1 = new PlumtreeGossip({ router: router1, peerId: 'peer1', ...opts1 });
  const p2 = new PlumtreeGossip({ router: router2, peerId: 'peer2', ...opts2 });

  // Wire send functions so messages flow between the two
  p1.setSendFn((toPeerId, msg) => {
    if (toPeerId === 'peer2') router2.route('peer1', msg);
  });
  p2.setSendFn((toPeerId, msg) => {
    if (toPeerId === 'peer1') router1.route('peer2', msg);
  });

  return { p1, p2, router1, router2 };
}

describe('PlumtreeGossip', () => {
  it('should require router and peerId', () => {
    assert.throws(() => new PlumtreeGossip({ peerId: 'p1' }), /router is required/);
    const r = new MessageRouter();
    assert.throws(() => new PlumtreeGossip({ router: r }), /peerId is required/);
  });

  it('should add peers as eager by default', () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1' });
    g.addPeer('peer2');
    g.addPeer('peer3');
    const state = g.getTreeState();
    assert.ok(state.eagerPeers.includes('peer2'));
    assert.ok(state.eagerPeers.includes('peer3'));
    assert.equal(state.lazyPeers.length, 0);
  });

  it('should not add self as peer', () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1' });
    g.addPeer('peer1');
    assert.equal(g.getTreeState().eagerPeers.length, 0);
  });

  it('should remove peers from both sets', () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1' });
    g.addPeer('peer2');
    g.removePeer('peer2');
    const state = g.getTreeState();
    assert.ok(!state.eagerPeers.includes('peer2'));
    assert.ok(!state.lazyPeers.includes('peer2'));
  });

  it('should emit tree:changed on addPeer', () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1' });
    const events = [];
    g.on('tree:changed', (e) => events.push(e));
    g.addPeer('peer2');
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'add_eager');
  });

  it('should publish and receive message between two peers', async () => {
    const { p1, p2 } = makePair();
    p1.addPeer('peer2');
    p2.addPeer('peer1');

    const received = [];
    p2.subscribe('test', (payload, from) => received.push({ payload, from }));

    p1.publish('test', { text: 'hello' });

    // Give async routing time to settle
    await new Promise(r => setTimeout(r, 50));

    assert.equal(received.length, 1);
    assert.deepStrictEqual(received[0].payload, { text: 'hello' });
    assert.equal(received[0].from, 'peer1');
  });

  it('should deduplicate received messages (dedup set)', async () => {
    const { p1, p2, router1, router2 } = makePair();
    p1.addPeer('peer2');
    p2.addPeer('peer1');

    const received = [];
    p2.on('message:received', (e) => received.push(e));

    const msgId = p1.publish('topic', 'data');
    // Simulate duplicate delivery
    await router2.route('peer1', {
      type: 'GOSSIP_MSG',
      id: 'duplicate-envelope',
      msgId,
      topic: 'topic',
      payload: 'data',
      origin: 'peer1',
      ttl: 5,
    });

    await new Promise(r => setTimeout(r, 20));
    // Should only count once (first delivery + 1 duplicate GOSSIP_MSG → deduplicated)
    const topicReceived = received.filter(e => e.msgId === msgId);
    assert.equal(topicReceived.length, 1);
  });

  it('should send PRUNE to sender on duplicate receipt', async () => {
    const { p1, p2, router1, router2 } = makePair();
    p1.addPeer('peer2');
    p2.addPeer('peer1');

    const sentFromP2 = [];
    p2.setSendFn((toPeerId, msg) => {
      sentFromP2.push({ toPeerId, msg });
      if (toPeerId === 'peer1') router1.route('peer2', msg);
    });

    // First, get p2 to see the message
    const msgId = p1.publish('topic', 'data');
    await new Promise(r => setTimeout(r, 30));

    // Send a duplicate
    await router2.route('peer1', {
      type: 'GOSSIP_MSG',
      id: 'dup2',
      msgId,
      topic: 'topic',
      payload: 'data',
      origin: 'peer1',
      ttl: 5,
    });

    await new Promise(r => setTimeout(r, 20));
    const pruneMsg = sentFromP2.find(s => s.msg.type === 'PRUNE');
    assert.ok(pruneMsg, 'Should have sent PRUNE on duplicate');
  });

  it('should send GRAFT when receiving new message from non-eager peer', async () => {
    const router1 = new MessageRouter();
    const router2 = new MessageRouter();

    const p1 = new PlumtreeGossip({ router: router1, peerId: 'peer1' });
    const p2 = new PlumtreeGossip({ router: router2, peerId: 'peer2' });

    // peer2 is lazy initially (peer1 won't be in p2's eager set)
    const sentFromP2 = [];
    p2.setSendFn((toPeerId, msg) => sentFromP2.push({ toPeerId, msg }));

    // Directly route a GOSSIP_MSG from peer1 to p2 (simulating lazy→eager upgrade)
    await router2.route('peer1', {
      type: 'GOSSIP_MSG',
      id: 'g1',
      msgId: 'msg-new',
      topic: 'topic',
      payload: 'new data',
      origin: 'peer1',
      ttl: 5,
    });

    const graftMsg = sentFromP2.find(s => s.msg.type === 'GRAFT');
    assert.ok(graftMsg, 'Should send GRAFT when receiving new message from non-eager peer');
  });

  it('should handle IHAVE/IWANT protocol', async () => {
    const router1 = new MessageRouter();
    const router2 = new MessageRouter();

    const p1 = new PlumtreeGossip({ router: router1, peerId: 'peer1' });
    const p2 = new PlumtreeGossip({ router: router2, peerId: 'peer2' });

    // p1 knows about a message, p2 doesn't
    const cachedMsg = {
      type: 'GOSSIP_MSG',
      id: 'orig',
      msgId: 'known-msg',
      topic: 'topic',
      payload: 'hello world',
      origin: 'peer0',
      ttl: 3,
    };
    // Put message in p1's cache by routing it through p1
    await router1.route('peer0', cachedMsg);

    // p2 sends IHAVE to p1 saying it has 'known-msg'
    // Actually reverse: p2 hasn't seen it, p1 sends IHAVE to p2
    const receivedOnP2 = [];
    p2.on('message:received', e => receivedOnP2.push(e));

    // Simulate p2 receiving an IHAVE for known-msg
    const sentFromP2 = [];
    p2.setSendFn((toPeerId, msg) => {
      sentFromP2.push({ toPeerId, msg });
      if (toPeerId === 'peer1') router1.route('peer2', msg);
    });
    p1.setSendFn((toPeerId, msg) => {
      if (toPeerId === 'peer2') router2.route('peer1', msg);
    });

    // p1 sends IHAVE to p2
    await router2.route('peer1', {
      type: 'IHAVE',
      id: 'ih1',
      msgIds: ['known-msg'],
    });

    await new Promise(r => setTimeout(r, 30));

    // p2 should have sent IWANT
    const iwant = sentFromP2.find(s => s.msg.type === 'IWANT');
    assert.ok(iwant, 'p2 should send IWANT for unknown message');
    assert.ok(iwant.msg.msgIds.includes('known-msg'));

    // p1 should have responded with GOSSIP_MSG
    assert.equal(receivedOnP2.length, 1);
    assert.equal(receivedOnP2[0].msgId, 'known-msg');
  });

  it('should handle GRAFT and PRUNE control messages', async () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1' });
    g.addPeer('peer2'); // eager

    // PRUNE → demote to lazy
    await router.route('peer2', { type: 'PRUNE', id: 'pr1', msgId: 'x' });
    assert.ok(g.getTreeState().lazyPeers.includes('peer2'), 'peer2 should be lazy after PRUNE');

    // GRAFT → promote back to eager
    await router.route('peer2', { type: 'GRAFT', id: 'gr1', msgId: 'x' });
    assert.ok(g.getTreeState().eagerPeers.includes('peer2'), 'peer2 should be eager after GRAFT');
  });

  it('should subscribe and unsubscribe topic handlers', async () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1' });
    const received = [];
    const handler = (payload) => received.push(payload);
    g.subscribe('news', handler);

    // Route a gossip message for 'news'
    await router.route('other', {
      type: 'GOSSIP_MSG',
      id: 'gm1',
      msgId: 'gm1',
      topic: 'news',
      payload: 'breaking',
      origin: 'other',
      ttl: 1,
    });

    assert.equal(received.length, 1);

    g.unsubscribe('news');
    await router.route('other', {
      type: 'GOSSIP_MSG',
      id: 'gm2',
      msgId: 'gm2',
      topic: 'news',
      payload: 'more news',
      origin: 'other',
      ttl: 1,
    });

    assert.equal(received.length, 1, 'should not receive after unsubscribe');
  });

  it('should publish with a required topic', () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1' });
    assert.throws(() => g.publish(), /topic is required/);
    assert.throws(() => g.publish(''), /topic is required/);
  });

  it('should batch IHAVE messages for lazy peers', async () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1', lazyPushDelayMs: 30 });

    const sent = [];
    g.setSendFn((toPeerId, msg) => sent.push({ toPeerId, msg }));

    // Add peer2 as eager first, then demote to lazy
    g.addPeer('peer2');
    await router.route('peer2', { type: 'PRUNE', id: 'pr', msgId: 'x' });

    // Publish multiple messages - should batch IHAVE
    g.publish('t', 'msg1');
    g.publish('t', 'msg2');
    g.publish('t', 'msg3');

    // Before delay, no IHAVE sent
    const ihaveBefore = sent.filter(s => s.msg.type === 'IHAVE');
    assert.equal(ihaveBefore.length, 0);

    // After delay
    await new Promise(r => setTimeout(r, 60));
    const ihaveAfter = sent.filter(s => s.msg.type === 'IHAVE');
    assert.ok(ihaveAfter.length > 0, 'should have sent batched IHAVE');
    // Batching: multiple msgIds in one IHAVE
    const totalMsgIds = ihaveAfter.reduce((sum, s) => sum + s.msg.msgIds.length, 0);
    assert.equal(totalMsgIds, 3);
  });

  it('should destroy and cancel IHAVE timer', async () => {
    const router = new MessageRouter();
    const g = new PlumtreeGossip({ router, peerId: 'peer1', lazyPushDelayMs: 50 });
    g.addPeer('peer2');
    await router.route('peer2', { type: 'PRUNE', id: 'pr', msgId: 'x' });
    g.publish('t', 'data');
    g.destroy(); // cancel timer
    // No error should be thrown
    await new Promise(r => setTimeout(r, 80));
  });
});
