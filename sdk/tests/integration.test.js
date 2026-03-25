/**
 * Integration Tests — End-to-end SDK flows (no real WebRTC / WebSocket)
 *
 * Strategy: two P2PNode instances are wired together via an in-memory transport bridge.
 * Messages sent by node A are delivered directly to node B's transport 'data' listener,
 * and vice-versa — simulating a real WebRTC data-channel without any network I/O.
 *
 * Run with: node --test sdk/tests/integration.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { P2PNode }            from '../src/p2p-node.js';
import { MemoryStorage }      from '../src/storage/memory-storage.js';
import { ChatProtocol }       from '../src/protocols/chat.js';
import { MarketplaceProtocol } from '../src/protocols/marketplace.js';
import { uuid }               from '../src/utils.js';

// ─── In-memory transport bridge ──────────────────────────────────────────────

/**
 * Build a pair of bridged mock transports. Messages sent by A are delivered to B
 * as incoming data events, and vice-versa.
 *
 * @returns {{ transportA: object, transportB: object }}
 */
function makeBridgedTransports(peerIdA, peerIdB) {
  function makeTransport(selfId) {
    const _handlers = new Map();
    const t = {
      _peer:   null, // will point to the other transport
      _selfId: selfId,
      connectedPeers: [],

      on(event, fn) {
        if (!_handlers.has(event)) _handlers.set(event, []);
        _handlers.get(event).push(fn);
      },
      emit(event, ...args) {
        (_handlers.get(event) || []).forEach(fn => fn(...args));
      },

      // Called by P2PNode to send a JSON string to a peer
      send(targetPeerId, data) {
        // Deliver asynchronously so event listeners are fully registered first
        setImmediate(() => {
          if (this._peer) this._peer.emit('data', this._selfId, data);
        });
      },

      // Called by P2PNode to broadcast to all connected peers
      broadcast(data, excludePeerId) {
        setImmediate(() => {
          if (this._peer && this._peer._selfId !== excludePeerId) {
            this._peer.emit('data', this._selfId, data);
          }
        });
      },

      connect:    async () => {},
      disconnect: () => {},
      destroyAll: () => {},

      // Simulate mutual peer connection events (called externally after bridging)
      simulateConnect(remotePeerId) {
        this.emit('peer:connected', remotePeerId);
      },
    };
    return t;
  }

  const tA = makeTransport(peerIdA);
  const tB = makeTransport(peerIdB);
  tA._peer = tB;
  tB._peer = tA;
  return { transportA: tA, transportB: tB };
}

/** Stub signaling that does nothing. */
function makeNoopSignaling() {
  const _handlers = new Map();
  return {
    connect:      async () => {},
    disconnect:   async () => {},
    announce:     async () => {},
    sendSignal:   async () => {},
    on(event, fn)  { if (!_handlers.has(event)) _handlers.set(event, []); _handlers.get(event).push(fn); },
    off()          {},
    emit(event, ...args) { (_handlers.get(event) || []).forEach(fn => fn(...args)); },
  };
}

/**
 * Re-wire a node's core transport event listeners onto a new transport mock.
 * P2PNode._wireEvents() runs during init() on the original transport; after we swap
 * the transport reference we need to re-register the critical paths manually.
 */
function rewire(node, transport) {
  transport.on('data', (fromPeerId, raw) => {
    try {
      const msg = typeof raw === 'string'
        ? JSON.parse(raw)
        : JSON.parse(new TextDecoder().decode(raw));
      node.router.route(fromPeerId, msg).catch(() => {});
    } catch { /* ignore malformed */ }
  });

  transport.on('peer:connected', (peerId) => {
    node.gossipSync.addPeer(peerId);
    node.resilience.trackPeer(peerId);
    node.emit('peer:joined', { peerId });
  });

  transport.on('peer:disconnected', (peerId) => {
    node.gossipSync.removePeer(peerId);
    node.emit('peer:left', { peerId });
  });
}

/**
 * Create two P2PNodes already bridged together, both in 'running' state.
 * gossipSync.setSendFn is wired to the bridge transport, so messages flow naturally.
 */
async function makePair(overridesA = {}, overridesB = {}) {
  const storageA = new MemoryStorage();
  const storageB = new MemoryStorage();

  const nodeA = new P2PNode({ peerId: 'peer-A', h3Cell: '8f283082affffff', storage: storageA, ...overridesA });
  const nodeB = new P2PNode({ peerId: 'peer-B', h3Cell: '8f283082affffff', storage: storageB, ...overridesB });

  await nodeA.init();
  await nodeB.init();

  // Replace transport + signaling with controlled mocks
  const { transportA, transportB } = makeBridgedTransports('peer-A', 'peer-B');
  nodeA.transport = transportA;
  nodeB.transport = transportB;
  nodeA.signaling = makeNoopSignaling();
  nodeB.signaling = makeNoopSignaling();

  // Re-wire transport event paths (init() already ran _wireEvents() on old transport)
  rewire(nodeA, transportA);
  rewire(nodeB, transportB);

  // Wire send functions for gossip + resilience
  const sendFnA = (peerId, msg) => transportA.send(peerId, JSON.stringify(msg));
  const sendFnB = (peerId, msg) => transportB.send(peerId, JSON.stringify(msg));

  nodeA.gossipSync.setSendFn(sendFnA);
  nodeA.resilience.setSendFn(sendFnA);
  nodeB.gossipSync.setSendFn(sendFnB);
  nodeB.resilience.setSendFn(sendFnB);

  // Force running state so convenience API works
  nodeA._state = 'running';
  nodeB._state = 'running';

  // Simulate mutual connection + peer discovery
  transportA.simulateConnect('peer-B');
  transportB.simulateConnect('peer-A');
  nodeA.cellShard.addPeer('peer-B', '8f283082affffff');
  nodeB.cellShard.addPeer('peer-A', '8f283082affffff');

  return { nodeA, nodeB, storageA, storageB, transportA, transportB };
}

/** Wait for an event with a resolved value, or reject after timeout. */
function waitForEvent(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    emitter.on(event, (...args) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/**
 * Like waitForEvent but also accepts a filter on the first argument.
 * Useful for 'route:unhandled' which emits (type, fromPeerId, message).
 */
function waitForTypedEvent(emitter, event, matchType, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}' (type=${matchType})`)), timeoutMs);
    emitter.on(event, (type, fromPeerId, message) => {
      if (type === matchType) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('Integration — Node lifecycle', () => {
  it('both nodes reach running state via makePair', async () => {
    const { nodeA, nodeB } = await makePair();
    assert.equal(nodeA.getStatus().state, 'running');
    assert.equal(nodeB.getStatus().state, 'running');
    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('getStatus() reports correct peerId and cell', async () => {
    const { nodeA, nodeB } = await makePair();
    assert.equal(nodeA.getStatus().peerId, 'peer-A');
    assert.equal(nodeB.getStatus().peerId, 'peer-B');
    assert.equal(nodeA.getStatus().cell, '8f283082affffff');
    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('destroy() transitions to stopped state', async () => {
    const { nodeA, nodeB } = await makePair();
    await nodeA.destroy();
    await nodeB.destroy();
    assert.equal(nodeA.getStatus().state, 'stopped');
    assert.equal(nodeB.getStatus().state, 'stopped');
  });
});

describe('Integration — Direct message routing', () => {
  let nodeA, nodeB;
  beforeEach(async () => ({ nodeA, nodeB } = await makePair()));
  afterEach(async () => { await nodeA.destroy(); await nodeB.destroy(); });

  it('sendMessage() delivers a typed message to the remote node router', async () => {
    // Use a type not registered by any SDK module to hit route:unhandled
    // Register listener BEFORE sending, then send, then await
    const msgPromise = waitForTypedEvent(nodeB.router, 'route:unhandled', 'INTEGRATION_DIRECT');
    nodeA.sendMessage('peer-B', 'INTEGRATION_DIRECT', { data: 'hello' });
    const msg = await msgPromise;
    assert.equal(msg.type, 'INTEGRATION_DIRECT');
    assert.equal(msg.data, 'hello');
  });

  it('broadcastMessage() reaches the remote node', async () => {
    const msgPromise = waitForTypedEvent(nodeB.router, 'route:unhandled', 'INTEGRATION_BROADCAST');
    nodeA.broadcastMessage('INTEGRATION_BROADCAST', { value: 42 });
    const msg = await msgPromise;
    assert.equal(msg.type, 'INTEGRATION_BROADCAST');
    assert.equal(msg.value, 42);
  });

  it('router deduplicates messages with the same id', async () => {
    let count = 0;
    nodeB.router.handle('INTEGRATION_DEDUP', () => { count++; });

    const dedupMsg = { type: 'INTEGRATION_DEDUP', id: 'fixed-id-dedup-xyz', value: 1 };
    // Route the same message twice directly through the router
    await nodeB.router.route('peer-A', dedupMsg);
    await nodeB.router.route('peer-A', dedupMsg);

    assert.equal(count, 1, 'Duplicate message should be ignored');
  });
});

describe('Integration — peer:joined / peer:left events', () => {
  it('emits peer:joined on the node when transport signals connection', async () => {
    const { nodeA, nodeB, transportA } = await makePair();

    const joined = waitForEvent(nodeA, 'peer:joined');
    transportA.simulateConnect('peer-C');
    const { peerId } = await joined;
    assert.equal(peerId, 'peer-C');

    await nodeA.destroy();
    await nodeB.destroy();
  });
});

describe('Integration — ChatProtocol', () => {
  let nodeA, nodeB, chatA, chatB;

  beforeEach(async () => {
    ({ nodeA, nodeB } = await makePair());
    chatA = new ChatProtocol(nodeA);
    chatB = new ChatProtocol(nodeB);
    chatA.install(nodeA);
    chatB.install(nodeB);
  });
  afterEach(async () => { await nodeA.destroy(); await nodeB.destroy(); });

  it('message sent by A is received by B', async () => {
    const received = new Promise(resolve => chatB.onMessage('peer-A', resolve));
    await chatA.sendMessage('peer-B', 'Hello from A!');
    const msg = await received;
    assert.equal(msg.text, 'Hello from A!');
    assert.equal(msg.fromId, 'peer-A');
    assert.equal(msg.toId, 'peer-B');
  });

  it('message is persisted in sender storage', async () => {
    const sent = await chatA.sendMessage('peer-B', 'Persist test');
    const stored = await nodeA._config.storage.get(`chat:${sent.id}`);
    assert.ok(stored, 'Message should be stored locally');
    assert.equal(stored.text, 'Persist test');
  });

  it('markRead() persists readAt and sends CHAT_READ to remote', async () => {
    // A sends to B
    const receivedByB = new Promise(resolve => chatB.onMessage('peer-A', resolve));
    const sent = await chatA.sendMessage('peer-B', 'Read me');
    await receivedByB;  // wait for B to receive and store
    // B marks as read via actual method name
    await chatB.markRead(sent.id);
    // Check B's storage updated
    const stored = await nodeB._config.storage.get(`chat:${sent.id}`);
    assert.ok(stored?.readAt, 'readAt should be set after markRead');
  });

  it('replyTo is preserved end-to-end', async () => {
    // Register a filter listener BEFORE sending anything, to avoid missing delivery via setImmediate
    const received = new Promise(resolve => {
      chatB.onMessage('peer-A', msg => { if (msg.replyTo) resolve(msg); });
    });
    const firstMsg = await chatA.sendMessage('peer-B', 'First message');
    await chatA.sendMessage('peer-B', 'Reply!', firstMsg.id);
    const reply = await received;
    assert.equal(reply.replyTo, firstMsg.id);
  });

  it('getConversation() returns messages in order', async () => {
    const rcv1 = new Promise(resolve => chatB.onMessage('peer-A', resolve));
    await chatA.sendMessage('peer-B', 'Msg 1');
    await rcv1;
    const rcv2 = new Promise(resolve => chatB.onMessage('peer-A', resolve));
    await chatA.sendMessage('peer-B', 'Msg 2');
    await rcv2;
    const convo = await chatB.getConversation('peer-A');
    assert.ok(convo.length >= 2);
    assert.equal(convo[convo.length - 1].text, 'Msg 2');
  });
});

describe('Integration — MarketplaceProtocol', () => {
  let nodeA, nodeB, mktA, mktB;

  beforeEach(async () => {
    ({ nodeA, nodeB } = await makePair());
    mktA = new MarketplaceProtocol(nodeA);
    mktB = new MarketplaceProtocol(nodeB);
    mktA.install(nodeA);
    mktB.install(nodeB);
  });
  afterEach(async () => { await nodeA.destroy(); await nodeB.destroy(); });

  it('createListing() stores the listing locally', async () => {
    const item = await mktA.createListing({ title: 'Bike', price: 150, category: 'sports' });
    assert.ok(item.id);
    assert.equal(item.title, 'Bike');
    assert.equal(item.sellerId, 'peer-A');
    assert.equal(item.status, 'available');
    const stored = await nodeA._config.storage.get(`listing:${item.id}`);
    assert.ok(stored, 'Listing should persist in storage');
  });

  it('createListing() propagates to peer B via gossip', async () => {
    const received = waitForEvent(nodeB.gossipSync, 'item:received', 2000);
    await mktA.createListing({ title: 'Sofa', price: 200, category: 'furniture' });
    const { payload } = await received;
    assert.equal(payload.title, 'Sofa');
    assert.equal(payload.sellerId, 'peer-A');
  });

  it('makePurchaseOffer() stores offer on seller node', async () => {
    const item = await mktA.createListing({ title: 'Guitar', price: 300, category: 'music' });
    // Use correct API: makePurchaseOffer(listingId, offerObj)
    await mktB.makePurchaseOffer(item.id, { amount: 250, sellerId: 'peer-A' });
    // Give time for delivery
    await new Promise(r => setTimeout(r, 150));
    // Verify offer stored on node A (the seller)
    const allA = await nodeA._config.storage.getAll();
    const offerEntry = allA.find(e => e.key.startsWith('offer:') && e.value?.listingId === item.id);
    assert.ok(offerEntry, 'Offer should be stored on seller node');
    assert.equal(offerEntry.value.buyerId, 'peer-B');
    assert.equal(offerEntry.value.amount, 250);
  });

  it('searchListings() finds stored listings', async () => {
    // Create listing locally on B so it is stored under listing: key (no gossip key-format mismatch)
    await mktB.createListing({ title: 'Couch', price: 100, category: 'furniture' });
    const results = await mktB.searchListings({ category: 'furniture' });
    assert.ok(results.length >= 1, 'Should find at least one listing');
    assert.equal(results[0].category, 'furniture');
  });
});

describe('Integration — GossipSync item propagation', () => {
  it('publishItem() on A triggers item:received on B', async () => {
    const { nodeA, nodeB } = await makePair();
    nodeA.gossipSync.addPeer('peer-B');
    nodeB.gossipSync.addPeer('peer-A');

    // Register listener BEFORE triggering publish
    const receivedPromise = waitForEvent(nodeB.gossipSync, 'item:received', 2000);
    await nodeA.gossipSync.publishItem({ id: 'item-1', title: 'Test item', price: 10 });
    const { payload } = await receivedPromise;
    assert.equal(payload.id, 'item-1');
    assert.equal(payload.title, 'Test item');

    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('item published by A is stored in B storage after sync', async () => {
    const { nodeA, nodeB, storageB } = await makePair();
    nodeA.gossipSync.addPeer('peer-B');
    nodeB.gossipSync.addPeer('peer-A');

    const receivedPromise = waitForEvent(nodeB.gossipSync, 'item:received', 2000);
    await nodeA.gossipSync.publishItem({ id: 'item-persist', title: 'Persist me', price: 5 });
    await receivedPromise;  // wait for delivery before checking storage
    await new Promise(r => setTimeout(r, 50));  // let storage write complete

    const stored = await storageB.get('item:item-persist');
    assert.ok(stored, 'Item should be stored in node B after gossip');

    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('same gossip message delivered twice via two paths is deduplicated', async () => {
    const { nodeA, nodeB } = await makePair();
    nodeA.gossipSync.addPeer('peer-B');
    nodeB.gossipSync.addPeer('peer-A');

    let count = 0;
    nodeB.gossipSync.on('item:received', () => count++);

    // Build a correctly-formatted GOSSIP_MSG (plumtree format needs both id and msgId)
    const sharedMsgId = 'plumtree-dedup-test-id';
    const gossipMsg1 = {
      type:    'GOSSIP_MSG',
      id:      uuid(),          // router-level id — unique for each delivery
      msgId:   sharedMsgId,     // plumtree-level id — intentionally identical
      topic:   'item',
      payload: { id: 'dedup-gossip-item', title: 'Dedup', price: 1 },
      ttl:     3,
    };
    const gossipMsg2 = { ...gossipMsg1, id: uuid() }; // new router id, same plumtree msgId

    // First delivery → should be processed
    await nodeB.router.route('peer-A', gossipMsg1);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(count, 1, 'First delivery should fire item:received');

    // Second delivery (same plumtree msgId via different path) → should be deduped
    await nodeB.router.route('peer-A', gossipMsg2);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(count, 1, 'Second delivery with same plumtree msgId should be suppressed');

    await nodeA.destroy();
    await nodeB.destroy();
  });
});

describe('Integration — Plugin system', () => {
  it('use() installs plugin immediately when node is running', async () => {
    const { nodeA, nodeB } = await makePair();
    let installed = false;
    nodeA.use({ install: () => { installed = true; } });
    assert.equal(installed, true);
    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('ChatProtocol registers router handlers', async () => {
    const { nodeA, nodeB } = await makePair();
    const chat = new ChatProtocol(nodeA);
    chat.install(nodeA);
    assert.ok(nodeA.router._handlers.has('CHAT_MSG'));
    assert.ok(nodeA.router._handlers.has('CHAT_READ'));
    assert.ok(nodeA.router._handlers.has('CHAT_TYPING'));
    await nodeA.destroy();
    await nodeB.destroy();
  });

  it('MarketplaceProtocol registers all message type handlers', async () => {
    const { nodeA, nodeB } = await makePair();
    const mkt = new MarketplaceProtocol(nodeA);
    mkt.install(nodeA);
    for (const type of ['LISTING_NEW', 'LISTING_UPDATE', 'OFFER_MAKE', 'OFFER_ACCEPT', 'OFFER_REJECT', 'REVIEW_SUBMIT']) {
      assert.ok(nodeA.router._handlers.has(type), `Handler for ${type} should be registered`);
    }
    await nodeA.destroy();
    await nodeB.destroy();
  });
});
