/**
 * Tests for WebSocketSignaling — centralised WS-based signaling.
 * Run with: node --test sdk/tests/websocket-signaling.test.js
 *
 * WebSocket is mocked globally — no real network connections.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, before, after } from 'node:test';
import { WebSocketSignaling } from '../src/signaling/websocket-signaling.js';

// ── MockWebSocket ─────────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN   = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url        = url;
    this.readyState = MockWebSocket.OPEN;
    this.sent       = [];
    this.onopen     = null;
    this.onmessage  = null;
    this.onclose    = null;
    this.onerror    = null;
    MockWebSocket._last = this;
    Promise.resolve().then(() => this.onopen?.());
  }

  send(data) { this.sent.push(data); }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    Promise.resolve().then(() => this.onclose?.({ code: 1000, reason: '' }));
  }

  /** Simulate a message from the server */
  deliver(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }

  static _last = null;
}

let _origWS;
before(()  => { _origWS = globalThis.WebSocket; globalThis.WebSocket = MockWebSocket; });
after(()   => { globalThis.WebSocket = _origWS; });
beforeEach(() => { MockWebSocket._last = null; });

// ── Helper ────────────────────────────────────────────────────────────────────

function makeSig(opts = {}) {
  return new WebSocketSignaling({
    url:    'ws://localhost:8765',
    peerId: 'peer_test1',
    ...opts,
  });
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('WebSocketSignaling — constructor', () => {
  it('stores url and peerId', () => {
    const s = makeSig();
    assert.equal(s._url,    'ws://localhost:8765');
    assert.equal(s.peerId,  'peer_test1');
  });

  it('starts offline', () => {
    const s = makeSig();
    assert.equal(s.isOnline, false);
  });

  it('accepts optional roomId', () => {
    const s = makeSig({ roomId: 'room-xyz' });
    assert.equal(s._roomId, 'room-xyz');
  });
});

// ── connect() ─────────────────────────────────────────────────────────────────

describe('WebSocketSignaling — connect()', () => {
  it('becomes online after WS connects', async () => {
    const s = makeSig();
    await s.connect();
    assert.equal(s.isOnline, true);
  });

  it('emits "online" status', async () => {
    const s = makeSig();
    const statuses = [];
    s.on('status', st => statuses.push(st));
    await s.connect();
    assert.ok(statuses.includes('online'));
  });

  it('sends announce immediately after connecting', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    const announces = ws.sent
      .map(m => JSON.parse(m))
      .filter(m => m.type === 'announce');
    assert.ok(announces.length >= 1, 'Must send announce on connect');
    assert.equal(announces[0].peerId, 'peer_test1');
  });

  it('includes roomId in announce message', async () => {
    const s = makeSig({ roomId: 'lobby' });
    await s.connect();
    const ws = MockWebSocket._last;
    const announce = ws.sent.map(m => JSON.parse(m)).find(m => m.type === 'announce');
    assert.equal(announce?.roomId, 'lobby');
  });
});

// ── disconnect() ──────────────────────────────────────────────────────────────

describe('WebSocketSignaling — disconnect()', () => {
  it('sets isOnline to false', async () => {
    const s = makeSig();
    await s.connect();
    await s.disconnect();
    assert.equal(s.isOnline, false);
  });

  it('emits "offline" status', async () => {
    const s = makeSig();
    const statuses = [];
    s.on('status', st => statuses.push(st));
    await s.connect();
    await s.disconnect();
    assert.ok(statuses.includes('offline'));
  });

  it('prevents auto-reconnect after intentional disconnect', async () => {
    const s = makeSig({ reconnectMs: 10 });
    await s.connect();
    await s.disconnect();
    // After intentional close, reconnect should NOT happen
    const onlineCount = (await new Promise(r => {
      let count = 0;
      const orig = s.emit.bind(s);
      s.emit = (ev, ...args) => { if (ev === 'status' && args[0] === 'online') count++; orig(ev, ...args); };
      setTimeout(() => r(count), 100);
    }));
    assert.equal(onlineCount, 0, 'Should not reconnect after intentional disconnect');
  });
});

// ── sendSignal() ──────────────────────────────────────────────────────────────

describe('WebSocketSignaling — sendSignal()', () => {
  it('sends a signal message over the WebSocket', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    ws.sent = [];

    await s.sendSignal('peer_other', { type: 'offer', sdp: 'mock-sdp' });

    const signal = ws.sent.map(m => JSON.parse(m)).find(m => m.type === 'signal');
    assert.ok(signal, 'Must send signal message');
    assert.equal(signal.target, 'peer_other');
    assert.equal(signal.from,   'peer_test1');
    assert.deepEqual(signal.signal, { type: 'offer', sdp: 'mock-sdp' });
  });

  it('no-op when not connected (readyState !== OPEN)', async () => {
    const s = makeSig();
    // Don't connect — _ws is null
    await assert.doesNotReject(() => s.sendSignal('p', { type: 'offer' }));
  });
});

// ── announce() ────────────────────────────────────────────────────────────────

describe('WebSocketSignaling — announce()', () => {
  it('sends announce with peerId', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    ws.sent = [];

    await s.announce({ extra: 'data' });

    const announce = ws.sent.map(m => JSON.parse(m)).find(m => m.type === 'announce');
    assert.ok(announce);
    assert.equal(announce.peerId, 'peer_test1');
  });

  it('includes meta in announce', async () => {
    const s = makeSig({ roomId: 'r1' });
    await s.connect();
    const ws = MockWebSocket._last;
    ws.sent = [];

    await s.announce({ h3Cell: 'abc', extra: 42 });

    const announce = ws.sent.map(m => JSON.parse(m)).find(m => m.type === 'announce');
    assert.deepEqual(announce.meta, { h3Cell: 'abc', extra: 42 });
  });
});

// ── _handleMessage() — incoming messages from server ─────────────────────────

describe('WebSocketSignaling — _handleMessage()', () => {
  it('emits "signal" on incoming signal message', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    const signals = [];
    s.on('signal', (from, sig) => signals.push({ from, sig }));

    ws.deliver({ type: 'signal', from: 'peer_other', signal: { type: 'offer', sdp: 'x' } });

    assert.equal(signals.length, 1);
    assert.equal(signals[0].from,      'peer_other');
    assert.equal(signals[0].sig.type,  'offer');
  });

  it('emits "peer:announce" on announce from another peer', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    const announces = [];
    s.on('peer:announce', (peerId, meta) => announces.push({ peerId, meta }));

    ws.deliver({ type: 'announce', peerId: 'peer_other', meta: { h3: 'cell1' } });

    assert.equal(announces.length, 1);
    assert.equal(announces[0].peerId, 'peer_other');
    assert.deepEqual(announces[0].meta, { h3: 'cell1' });
  });

  it('ignores self-announce', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    const announces = [];
    s.on('peer:announce', () => announces.push(1));

    ws.deliver({ type: 'announce', peerId: 'peer_test1' }); // same as our peerId

    assert.equal(announces.length, 0, 'Should not emit announce for self');
  });

  it('emits "peer:announce" on peer-joined message', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    const announces = [];
    s.on('peer:announce', (peerId) => announces.push(peerId));

    ws.deliver({ type: 'peer-joined', peerId: 'peer_newbie' });

    assert.equal(announces.length, 1);
    assert.equal(announces[0], 'peer_newbie');
  });

  it('emits "peer:left" on peer-left message', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    const left = [];
    s.on('peer:left', (peerId) => left.push(peerId));

    ws.deliver({ type: 'peer-left', peerId: 'peer_gone' });

    assert.equal(left.length, 1);
    assert.equal(left[0], 'peer_gone');
  });

  it('emits "ice-config" on ice-config message', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    const configs = [];
    s.on('ice-config', (cfg) => configs.push(cfg));

    const iceServers = [{ urls: 'turn:turn.test.com' }];
    ws.deliver({ type: 'ice-config', config: { iceServers } });

    assert.equal(configs.length, 1);
    assert.deepEqual(configs[0].iceServers, iceServers);
  });

  it('ignores unknown message types without throwing', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    assert.doesNotThrow(() => ws.deliver({ type: 'unknown_type', data: 'whatever' }));
  });

  it('ignores malformed JSON without throwing', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    assert.doesNotThrow(() => ws.onmessage?.({ data: '{not valid json' }));
  });

  it('ignores announce message with missing from field', async () => {
    const s = makeSig();
    await s.connect();
    const ws = MockWebSocket._last;
    const announces = [];
    s.on('peer:announce', () => announces.push(1));
    ws.deliver({ type: 'announce' }); // no peerId
    assert.equal(announces.length, 0);
  });
});
