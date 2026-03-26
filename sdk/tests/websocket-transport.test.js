/**
 * Tests for WebSocketTransport — per-peer WebSocket connection management.
 * Run with: node --test sdk/tests/websocket-transport.test.js
 *
 * globalThis.WebSocket is mocked to avoid a real network. Reconnect is suppressed
 * by setting transport.reconnectMaxAttempts to 0 in all tests.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, before, after } from 'node:test';
import config from '../src/config.js';
import { WebSocketTransport } from '../src/transport/websocket-transport.js';

// ── MockWebSocket ─────────────────────────────────────────────────────────────

class MockWS {
  constructor(url) {
    this.url         = url;
    this.readyState  = MockWS.CONNECTING;
    this.sent        = [];
    this.onopen      = null;
    this.onclose     = null;
    this.onmessage   = null;
    this.onerror     = null;
    MockWS._instances.push(this);
  }

  static CONNECTING = 0;
  static OPEN       = 1;
  static CLOSING    = 2;
  static CLOSED     = 3;

  send(data)  { if (this.readyState !== MockWS.OPEN) throw new Error('not open'); this.sent.push(data); }

  close(code, reason) {
    this.readyState = MockWS.CLOSED;
    // Fire asynchronously to match browser semantics and avoid reconnect race
    Promise.resolve().then(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }));
  }

  /** Simulate a successful connection */
  _open()                  { this.readyState = MockWS.OPEN;  Promise.resolve().then(() => this.onopen?.()); }
  /** Inject an inbound message */
  _deliver(data)           { this.onmessage?.({ data }); }
  /** Simulate a socket error */
  _error(err)              { this.onerror?.(err); }

  static _instances = [];
  static reset()           { MockWS._instances = []; }
  static last()            { return MockWS._instances[MockWS._instances.length - 1]; }
}

before(() => {
  globalThis.WebSocket       = MockWS;
  // Expose WebSocket.OPEN constant consumed by WebSocketTransport
  globalThis.WebSocket.OPEN  = MockWS.OPEN;
});
after(() => { delete globalThis.WebSocket; });

beforeEach(() => {
  MockWS.reset();
  // Suppress reconnects completely so tests don't leak timers
  config.set('transport.reconnectMaxAttempts', 0);
});

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// ── Constructor ───────────────────────────────────────────────────────────────

describe('WebSocketTransport — constructor', () => {
  it('starts with no peers', () => {
    const t = new WebSocketTransport();
    assert.deepEqual(t.peers(), []);
  });
});

// ── connect() ─────────────────────────────────────────────────────────────────

describe('WebSocketTransport — connect()', () => {
  it('throws when peerId is missing', async () => {
    const t = new WebSocketTransport();
    await assert.rejects(() => t.connect('', 'ws://x'), TypeError);
  });

  it('throws when url is missing', async () => {
    const t = new WebSocketTransport();
    await assert.rejects(() => t.connect('p1', ''), TypeError);
  });

  it('emits "open" event after successful connection', async () => {
    const t      = new WebSocketTransport();
    const events = [];
    t.on('open', e => events.push(e));

    const connectP = t.connect('p1', 'ws://peer1');
    MockWS.last()._open();
    await connectP;

    assert.equal(events.length, 1);
    assert.equal(events[0].peerId, 'p1');
  });

  it('does not open duplicate connection to same peerId', async () => {
    const t = new WebSocketTransport();
    const p = t.connect('p1', 'ws://peer1');
    MockWS.last()._open();
    await p;

    // Second call must be a no-op
    await t.connect('p1', 'ws://peer1-alt');
    assert.equal(MockWS._instances.length, 1);
  });

  it('rejects when socket emits an error before open', async () => {
    const t  = new WebSocketTransport();
    const p  = t.connect('p1', 'ws://bad');
    MockWS.last()._error(new Error('connection refused'));
    await assert.rejects(() => p);
  });
});

// ── send() ────────────────────────────────────────────────────────────────────

describe('WebSocketTransport — send()', () => {
  it('returns false for unknown peer', () => {
    assert.equal(new WebSocketTransport().send('nobody', 'data'), false);
  });

  it('returns false when socket is not yet open', () => {
    const t = new WebSocketTransport();
    t.connect('p1', 'ws://x'); // not awaited — still CONNECTING
    assert.equal(t.send('p1', 'hello'), false);
  });

  it('returns true and sends data when socket is open', async () => {
    const t = new WebSocketTransport();
    const p = t.connect('p1', 'ws://peer1');
    MockWS.last()._open();
    await p;

    const result = t.send('p1', 'hello');
    assert.equal(result, true);
    assert.ok(MockWS.last().sent.includes('hello'));
  });
});

// ── broadcast() ───────────────────────────────────────────────────────────────

describe('WebSocketTransport — broadcast()', () => {
  it('sends to every connected peer', async () => {
    const t = new WebSocketTransport();

    const p1 = t.connect('a', 'ws://a');
    const ws1 = MockWS.last();
    ws1._open();
    await p1;

    const p2 = t.connect('b', 'ws://b');
    const ws2 = MockWS.last();
    ws2._open();
    await p2;

    t.broadcast('ping');
    assert.ok(ws1.sent.includes('ping'));
    assert.ok(ws2.sent.includes('ping'));
  });
});

// ── Message event ─────────────────────────────────────────────────────────────

describe('WebSocketTransport — inbound messages', () => {
  it('emits "message" event with peerId and data', async () => {
    const t    = new WebSocketTransport();
    const msgs = [];
    t.on('message', e => msgs.push(e));

    const p  = t.connect('p1', 'ws://p1');
    const ws = MockWS.last();
    ws._open();
    await p;

    ws._deliver('{"hello":1}');

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].peerId, 'p1');
    assert.equal(msgs[0].data,   '{"hello":1}');
  });
});

// ── Error event ───────────────────────────────────────────────────────────────

describe('WebSocketTransport — socket error after open', () => {
  it('emits "error" event after open', async () => {
    const t      = new WebSocketTransport();
    const errors = [];
    t.on('error', e => errors.push(e));

    const p  = t.connect('p1', 'ws://p1');
    const ws = MockWS.last();
    ws._open();
    await p;

    ws._error(new Error('network failure'));

    assert.equal(errors.length, 1);
    assert.equal(errors[0].peerId, 'p1');
  });
});

// ── disconnect() ─────────────────────────────────────────────────────────────

describe('WebSocketTransport — disconnect()', () => {
  it('removes peer immediately', async () => {
    const t = new WebSocketTransport();
    const p = t.connect('p1', 'ws://p1');
    MockWS.last()._open();
    await p;

    t.disconnect('p1');
    assert.equal(t.peers().length, 0);
  });

  it('emits "close" event on manual disconnect', async () => {
    const t      = new WebSocketTransport();
    const events = [];
    t.on('close', e => events.push(e));

    const p = t.connect('p1', 'ws://p1');
    MockWS.last()._open();
    await p;

    t.disconnect('p1');
    assert.ok(events.find(e => e.peerId === 'p1'));
  });

  it('is a no-op for unknown peer', () => {
    assert.doesNotThrow(() => new WebSocketTransport().disconnect('nobody'));
  });
});

// ── close() ──────────────────────────────────────────────────────────────────

describe('WebSocketTransport — close()', () => {
  it('removes all peers', async () => {
    const t = new WebSocketTransport();

    const p1 = t.connect('a', 'ws://a');
    MockWS._instances[0]._open();
    await p1;

    const p2 = t.connect('b', 'ws://b');
    MockWS._instances[1]._open();
    await p2;

    t.close();
    assert.deepEqual(t.peers(), []);
  });
});

// ── Reconnect logic ───────────────────────────────────────────────────────────

describe('WebSocketTransport — reconnect', () => {
  it('does NOT reconnect when maxAttempts=0', async () => {
    config.set('transport.reconnectMaxAttempts', 0);

    const t = new WebSocketTransport();
    const p = t.connect('p1', 'ws://p1');
    const ws = MockWS.last();
    ws._open();
    await p;

    // Simulate remote close
    ws.readyState = MockWS.CLOSED;
    ws.onclose?.({ code: 1006, reason: 'abnormal' });
    await tick(30);

    // Peer should be removed (maxAttempts=0 → give-up immediately)
    assert.equal(t.peers().includes('p1'), false);
    // Only the initial socket should have been created
    assert.equal(MockWS._instances.length, 1);
  });

  it('schedules reconnect when maxAttempts>0', async () => {
    config.set('transport.reconnectMaxAttempts', 1);
    config.set('transport.reconnectBaseDelay', 5);
    config.set('transport.reconnectMaxDelay',  50);

    const t = new WebSocketTransport();
    const p = t.connect('p1', 'ws://p1');
    const ws = MockWS.last();
    ws._open();
    await p;

    // Simulate remote close
    ws.readyState = MockWS.CLOSED;
    ws.onclose?.({ code: 1006, reason: 'drop' });

    // Wait for the reconnect timer to fire
    await tick(80);

    // A second WebSocket should have been created
    assert.ok(MockWS._instances.length >= 2, 'Reconnect should attempt a new WebSocket');
  });
});
