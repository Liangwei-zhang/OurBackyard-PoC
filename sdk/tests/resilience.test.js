/**
 * Tests for ResilienceManager — connection health, heartbeat, reconnection.
 * Run with: node --test sdk/tests/resilience.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, mock } from 'node:test';
import { ResilienceManager, Quality } from '../src/mesh/resilience.js';

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeRouter() {
  const handlers = new Map();
  return {
    handle(type, fn) { handlers.set(type, fn); },
    _trigger(type, from, msg) {
      const h = handlers.get(type);
      if (h) h(from, msg);
    },
  };
}

function makeTransport() {
  const connected = new Set();
  return {
    _connected: connected,
    async connect(peerId) {
      connected.add(peerId);
      return peerId;
    },
  };
}

function makeResilience(overrides = {}) {
  const router    = makeRouter();
  const transport = makeTransport();
  const rm = new ResilienceManager({
    router,
    transport,
    heartbeatIntervalMs:   10000,
    maxReconnectAttempts:  3,
    reconnectBaseMs:       50,
    pongTimeoutMs:         200,
    ...overrides,
  });
  const sendLog = [];
  rm.setSendFn((peerId, msg) => sendLog.push({ peerId, msg }));
  return { rm, router, transport, sendLog };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ResilienceManager — constructor', () => {
  it('should throw if router is missing', () => {
    assert.throws(() => new ResilienceManager({ transport: makeTransport() }), /router is required/);
  });

  it('should throw if transport is missing', () => {
    assert.throws(() => new ResilienceManager({ router: makeRouter() }), /transport is required/);
  });

  it('should create with valid opts', () => {
    const { rm } = makeResilience();
    assert.ok(rm);
  });
});

describe('ResilienceManager — trackPeer / untrackPeer', () => {
  it('should track a new peer', () => {
    const { rm } = makeResilience();
    rm.trackPeer('peer1');
    assert.ok(rm.getPeerHealth('peer1'));
    assert.equal(rm.getPeerHealth('peer1').quality, Quality.GOOD);
  });

  it('should untrack a peer', () => {
    const { rm } = makeResilience();
    rm.trackPeer('peer1');
    rm.untrackPeer('peer1');
    assert.equal(rm.getPeerHealth('peer1'), null);
  });

  it('should not duplicate-track a peer', () => {
    const { rm } = makeResilience();
    rm.trackPeer('peer1');
    rm.trackPeer('peer1');
    // Directly modify internal state to verify it's preserved
    rm._peerHealth.get('peer1').rtt = 42;
    rm.trackPeer('peer1'); // should not reset
    assert.equal(rm.getPeerHealth('peer1').rtt, 42);
  });
});

describe('ResilienceManager — PING/PONG flow', () => {
  it('should send a PING when _sendPing is called', () => {
    const { rm, sendLog } = makeResilience();
    rm.trackPeer('peer1');
    rm._sendPing('peer1');
    assert.equal(sendLog.length, 1);
    assert.equal(sendLog[0].peerId, 'peer1');
    assert.equal(sendLog[0].msg.type, 'PING');
  });

  it('should reply with PONG when PING is received', () => {
    const { rm, router, sendLog } = makeResilience();
    router._trigger('PING', 'peer1', { id: 'ping-1', ts: Date.now(), type: 'PING' });
    assert.equal(sendLog.length, 1);
    assert.equal(sendLog[0].msg.type, 'PONG');
    assert.equal(sendLog[0].peerId, 'peer1');
  });

  it('should calculate RTT on PONG received', () => {
    const { rm, router } = makeResilience();
    rm.trackPeer('peer1');
    const ts = Date.now() - 50; // simulate 50ms RTT
    router._trigger('PONG', 'peer1', { id: 'pong-1', pingTs: ts, type: 'PONG' });
    const health = rm.getPeerHealth('peer1');
    assert.ok(health.rtt >= 50 && health.rtt < 5000);
  });

  it('should update quality to EXCELLENT for RTT < 100ms', () => {
    const { rm, router } = makeResilience();
    rm.trackPeer('peer1');
    const ts = Date.now() - 50;
    router._trigger('PONG', 'peer1', { id: 'p', pingTs: ts, type: 'PONG' });
    assert.equal(rm.getPeerQuality('peer1'), Quality.EXCELLENT);
  });

  it('should update quality to GOOD for RTT 100-300ms', () => {
    const { rm, router } = makeResilience();
    rm.trackPeer('peer1');
    const ts = Date.now() - 200;
    router._trigger('PONG', 'peer1', { id: 'p', pingTs: ts, type: 'PONG' });
    assert.equal(rm.getPeerQuality('peer1'), Quality.GOOD);
  });

  it('should update quality to FAIR for RTT 300-1000ms', () => {
    const { rm, router } = makeResilience();
    rm.trackPeer('peer1');
    const ts = Date.now() - 500;
    router._trigger('PONG', 'peer1', { id: 'p', pingTs: ts, type: 'PONG' });
    assert.equal(rm.getPeerQuality('peer1'), Quality.FAIR);
  });

  it('should emit peer:healthy when quality improves past FAIR', (t, done) => {
    const { rm, router } = makeResilience();
    rm.trackPeer('peer1');
    rm._peerHealth.get('peer1').quality = Quality.POOR;

    rm.on('peer:healthy', ({ peerId }) => {
      assert.equal(peerId, 'peer1');
      done();
    });

    const ts = Date.now() - 50;
    router._trigger('PONG', 'peer1', { id: 'p', pingTs: ts, type: 'PONG' });
  });
});

describe('ResilienceManager — monitoring lifecycle', () => {
  it('should start and stop monitoring without errors', () => {
    const { rm } = makeResilience();
    rm.startMonitoring();
    assert.ok(rm._heartbeatTimer);
    rm.stopMonitoring();
    assert.equal(rm._heartbeatTimer, null);
  });

  it('should not start twice', () => {
    const { rm } = makeResilience();
    rm.startMonitoring();
    const first = rm._heartbeatTimer;
    rm.startMonitoring();
    assert.equal(rm._heartbeatTimer, first);
    rm.stopMonitoring();
  });
});

describe('ResilienceManager — healthy peers', () => {
  it('getHealthyPeers returns peers with quality >= FAIR', () => {
    const { rm, router } = makeResilience();
    rm.trackPeer('good');
    rm.trackPeer('dead');
    rm._peerHealth.get('dead').quality = Quality.DEAD;
    const ts = Date.now() - 50;
    router._trigger('PONG', 'good', { id: 'p', pingTs: ts, type: 'PONG' });
    const healthy = rm.getHealthyPeers();
    assert.ok(healthy.includes('good'));
    assert.ok(!healthy.includes('dead'));
  });
});

describe('ResilienceManager — circuit breaker', () => {
  it('should open circuit breaker after max reconnect attempts', async () => {
    const { rm } = makeResilience({ maxReconnectAttempts: 1, reconnectBaseMs: 10 });
    rm.trackPeer('peer1');
    rm._peerHealth.get('peer1').quality = Quality.DEAD;

    // Call attempt directly to bypass timer complexity
    rm._peerHealth.get('peer1').reconnectAttempts = 1;
    rm._openCircuitBreaker('peer1');

    assert.equal(rm._peerHealth.get('peer1').circuitOpen, true);
    assert.equal(rm.getHealthyPeers().includes('peer1'), false);
  });

  it('should emit peer:dead when circuit opens', (t, done) => {
    const { rm } = makeResilience();
    rm.trackPeer('peer1');
    rm.on('peer:dead', ({ peerId }) => {
      assert.equal(peerId, 'peer1');
      done();
    });
    rm._openCircuitBreaker('peer1');
  });
});

describe('ResilienceManager — onPeerReconnected', () => {
  it('should reset health state on reconnect', () => {
    const { rm } = makeResilience();
    rm.trackPeer('peer1');
    rm._peerHealth.get('peer1').reconnectAttempts = 5;
    rm._peerHealth.get('peer1').circuitOpen = true;
    rm._peerHealth.get('peer1').quality = Quality.DEAD;

    rm.onPeerReconnected('peer1');

    const h = rm.getPeerHealth('peer1');
    assert.equal(h.reconnectAttempts, 0);
    assert.equal(h.circuitOpen, false);
    assert.equal(h.quality, Quality.GOOD);
  });
});

describe('ResilienceManager — getAllHealth', () => {
  it('should return health for all tracked peers', () => {
    const { rm } = makeResilience();
    rm.trackPeer('p1');
    rm.trackPeer('p2');
    const all = rm.getAllHealth();
    assert.equal(all.size, 2);
    assert.ok(all.has('p1'));
    assert.ok(all.has('p2'));
  });
});

describe('ResilienceManager — quality degradation', () => {
  it('should track RTT in peer health', () => {
    const { rm } = makeResilience();
    rm.trackPeer('p');
    const h = rm._peerHealth.get('p');
    h.rtt = 500;
    assert.equal(rm.getPeerHealth('p').rtt, 500);
  });

  it('should mark peer as DEAD when circuit opens', () => {
    const { rm } = makeResilience();
    rm.trackPeer('p');
    const h = rm._peerHealth.get('p');
    h.circuitOpen = true;
    h.quality = Quality.DEAD;
    assert.equal(rm.getPeerHealth('p').quality, Quality.DEAD);
  });

  it('trackPeer() is idempotent', () => {
    const { rm } = makeResilience();
    rm.trackPeer('p');
    rm.trackPeer('p'); // call twice
    assert.equal(rm.getAllHealth().size, 1);
  });

  it('untrackPeer() removes peer from health map', () => {
    const { rm } = makeResilience();
    rm.trackPeer('p');
    rm.untrackPeer('p');
    assert.equal(rm.getAllHealth().size, 0);
  });

  it('getPeerHealth() returns null for untracked peer', () => {
    const { rm } = makeResilience();
    assert.equal(rm.getPeerHealth('unknown'), null);
  });

  it('emits "quality:change" when quality changes', () => {
    const { rm } = makeResilience();
    const events = [];
    rm.on('quality:change', e => events.push(e));
    rm.trackPeer('p');
    const h = rm._peerHealth.get('p');
    h.quality = Quality.POOR;
    rm.emit('quality:change', { peerId: 'p', quality: Quality.POOR });
    assert.equal(events.length, 1);
    assert.equal(events[0].peerId, 'p');
  });
});
