/**
 * Tests for P2PNode orchestrator.
 * Run with: node --test sdk/tests/p2p-node.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { P2PNode } from '../src/p2p-node.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

// ── Mock helpers ─────────────────────────────────────────────────────────────

/** A minimal ISignaling mock */
function makeSignaling() {
  return {
    connect:      async () => {},
    disconnect:   async () => {},
    announce:     async () => {},
    sendSignal:   async () => {},
    on:           () => {},
    off:          () => {},
    emit:         () => {},
    // Track emitted events so tests can inspect them
    _handlers: new Map(),
    on(event, fn) { if (!this._handlers.has(event)) this._handlers.set(event, []); this._handlers.get(event).push(fn); },
    emit(event, ...args) { (this._handlers.get(event) || []).forEach(fn => fn(...args)); },
  };
}

/** A minimal WebRTCTransport mock */
function makeTransport() {
  const _handlers = new Map();
  return {
    _handlers,
    send:       () => {},
    broadcast:  () => {},
    connect:    async () => {},
    disconnect: () => {},
    destroyAll: () => {},
    connectedPeers: [],
    on(event, fn) {
      if (!_handlers.has(event)) _handlers.set(event, []);
      _handlers.get(event).push(fn);
    },
    emit(event, ...args) { (_handlers.get(event) || []).forEach(fn => fn(...args)); },
  };
}

/**
 * Create a P2PNode with injected mocks so we don't need real WebRTC/WebSocket.
 */
async function makeMockNode(configOverrides = {}) {
  const storage = new MemoryStorage();
  const node = new P2PNode({
    peerId:        'test-peer',
    h3Cell:        '8f283082affffff',
    signalingType: 'websocket',
    signalingUrl:  'ws://localhost:9999',
    storage,
    ...configOverrides,
  });
  await node.init();

  // Replace transport and signaling with mocks after init
  const mockTransport  = makeTransport();
  const mockSignaling  = makeSignaling();
  node.transport  = mockTransport;
  node.signaling  = mockSignaling;

  return { node, storage, mockTransport, mockSignaling };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('P2PNode — config validation', () => {
  it('should auto-generate peerId if not provided', () => {
    const node = new P2PNode({});
    assert.ok(node._config.peerId);
    assert.ok(node._config.peerId.length > 5);
  });

  it('should use default h3Cell if not provided', () => {
    const node = new P2PNode({});
    assert.equal(node._config.h3Cell, '8f283082affffff');
  });

  it('should use provided peerId', () => {
    const node = new P2PNode({ peerId: 'custom-id' });
    assert.equal(node._config.peerId, 'custom-id');
  });

  it('should apply default heartbeatIntervalMs', () => {
    const node = new P2PNode({});
    assert.equal(node._config.heartbeatIntervalMs, 15000);
  });

  it('should merge custom config', () => {
    const node = new P2PNode({ maxPeersPerCell: 50 });
    assert.equal(node._config.maxPeersPerCell, 50);
  });
});

describe('P2PNode — lifecycle', () => {
  it('should start in created state', () => {
    const node = new P2PNode({});
    assert.equal(node._state, 'created');
  });

  it('should transition to ready after init()', async () => {
    const { node } = await makeMockNode();
    assert.equal(node._state, 'ready');
  });

  it('should emit ready event on init()', async () => {
    const node = new P2PNode({ peerId: 'p1', signalingUrl: 'ws://localhost' });
    let readyFired = false;
    node.on('ready', () => { readyFired = true; });
    await node.init();
    assert.ok(readyFired);
  });

  it('should throw if init() called twice', async () => {
    const { node } = await makeMockNode();
    await assert.rejects(() => node.init(), /invalid state/);
  });

  it('should transition to running after start()', async () => {
    const { node } = await makeMockNode();
    await node.start();
    assert.equal(node._state, 'running');
    await node.stop();
  });

  it('should transition to stopped after stop()', async () => {
    const { node } = await makeMockNode();
    await node.start();
    await node.stop();
    assert.equal(node._state, 'stopped');
  });

  it('should throw if start() called in wrong state', async () => {
    const node = new P2PNode({ signalingUrl: 'ws://localhost' });
    await assert.rejects(() => node.start(), /invalid state/);
  });

  it('should support destroy() from running', async () => {
    const { node } = await makeMockNode();
    await node.start();
    await node.destroy();
    assert.equal(node._state, 'stopped');
  });

  it('should support destroy() from ready (not running)', async () => {
    const { node } = await makeMockNode();
    await node.destroy();
    assert.equal(node._state, 'stopped');
  });
});

describe('P2PNode — module wiring', () => {
  it('should create all required sub-modules after init()', async () => {
    const { node } = await makeMockNode();
    assert.ok(node.transport,   'transport');
    assert.ok(node.signaling,   'signaling');
    assert.ok(node.router,      'router');
    assert.ok(node.gossipSync,  'gossipSync');
    assert.ok(node.blobTransfer,'blobTransfer');
    assert.ok(node.cellShard,   'cellShard');
    assert.ok(node.resilience,  'resilience');
  });

  it('cellShard should use configured h3Cell', async () => {
    const { node } = await makeMockNode({ h3Cell: '8f2830821ffffff' });
    assert.equal(node.cellShard.myCell, '8f2830821ffffff');
  });
});

describe('P2PNode — plugin system', () => {
  it('should register and install plugins during init()', async () => {
    const node = new P2PNode({ peerId: 'p1', signalingUrl: 'ws://localhost' });
    let installed = false;
    const plugin = { install: () => { installed = true; } };
    node.use(plugin);
    await node.init();
    assert.ok(installed);
  });

  it('should install plugin immediately if node is already initialised', async () => {
    const { node } = await makeMockNode();
    let installed = false;
    const plugin = { install: () => { installed = true; } };
    node.use(plugin);
    assert.ok(installed);
  });
});

describe('P2PNode — getStatus', () => {
  it('should return status snapshot', async () => {
    const { node } = await makeMockNode({ peerId: 'snap-peer' });
    const status = node.getStatus();
    assert.equal(status.peerId, 'snap-peer');
    assert.equal(status.state, 'ready');
    assert.ok('peerCount' in status);
    assert.ok('cell' in status);
  });
});

describe('P2PNode — getPeers', () => {
  it('should return empty array initially', async () => {
    const { node } = await makeMockNode();
    assert.deepEqual(node.getPeers(), []);
  });

  it('should include peers added to cellShard', async () => {
    const { node } = await makeMockNode();
    node.cellShard.addPeer('remote-peer', '8f283082bffffff');
    const peers = node.getPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].peerId, 'remote-peer');
  });
});

describe('P2PNode — convenience methods guard', () => {
  it('sendMessage throws if not running', async () => {
    const { node } = await makeMockNode();
    assert.throws(() => node.sendMessage('p', 'TYPE', {}), /not running/);
  });

  it('broadcastMessage throws if not running', async () => {
    const { node } = await makeMockNode();
    assert.throws(() => node.broadcastMessage('TYPE', {}), /not running/);
  });

  it('publishItem throws if not running', async () => {
    const { node } = await makeMockNode();
    await assert.rejects(() => node.publishItem({ id: 'x' }), /not running/);
  });
});
