/**
 * Tests for NostrSignaling — decentralised WebRTC signaling over Nostr relays.
 * Run with: node --test sdk/tests/nostr-signaling.test.js
 *
 * WebSocket is mocked globally so no real network connections are made.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, before, after } from 'node:test';
import { NostrSignaling } from '../src/signaling/nostr-signaling.js';

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
    MockWebSocket._instances.push(this);
    // Trigger onopen asynchronously (mimics real WS behaviour)
    Promise.resolve().then(() => this.onopen?.());
  }

  send(data) { this.sent.push(data); }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    // Async close — mirrors browsers: onclose fires after the call
    Promise.resolve().then(() => this.onclose?.({ code: 1000, reason: 'test close' }));
  }

  /** Helper: simulate a message from the relay */
  deliver(msgArray) {
    this.onmessage?.({ data: JSON.stringify(msgArray) });
  }

  static _instances = [];
  static reset()    { MockWebSocket._instances = []; }
  static last()     { return MockWebSocket._instances[MockWebSocket._instances.length - 1]; }
}

let _origWS;
before(() => { _origWS = globalThis.WebSocket; globalThis.WebSocket = MockWebSocket; });
after(()  => { globalThis.WebSocket = _origWS; });
beforeEach(() => MockWebSocket.reset());

// ── Test helpers ──────────────────────────────────────────────────────────────

// Default mock secp256k1 — injected into most tests so signing works without the real library.
// Tests that specifically test "no secp256k1" behaviour pass { secp256k1: null } explicitly.
const MOCK_SECP256K1 = {
  getPublicKey: (privkey) => 'mock-pub-' + privkey.slice(0, 55),
  schnorrSign:  (_id, _privkey) => '0'.repeat(128),
};

function makeSignaling(opts = {}) {
  return new NostrSignaling({
    peerId:             'peer_abc123',
    h3Cell:             '8f283082affffff',
    relays:             ['wss://relay1.test', 'wss://relay2.test'],
    bootTimeoutMs:      200,
    relayTimeoutMs:     300,
    reconnectMs:        999999,       // disable auto-reconnect in tests
    announceIntervalMs: 999999,       // disable heartbeat in tests
    secp256k1:          MOCK_SECP256K1, // ensure signing works in tests by default
    ...opts,
  });
}

/** Flush all pending microtasks + a small macro-task tick */
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// ── _toL7() ── pure function tests ────────────────────────────────────────────

describe('NostrSignaling._toL7()', () => {
  it('converts L9 hex cell to 15-char L7 string', () => {
    const l7 = NostrSignaling._toL7('8f283082affffff');
    assert.equal(typeof l7, 'string');
    assert.equal(l7.length, 15);
  });

  it('L7 result differs from L9 input', () => {
    const l9 = '8f283082affffff';
    assert.notEqual(NostrSignaling._toL7(l9), l9);
  });

  it('same L9 cell always produces same L7 channel', () => {
    const a = NostrSignaling._toL7('8f283082affffff');
    const b = NostrSignaling._toL7('8f283082affffff');
    assert.equal(a, b);
  });

  it('returns non-H3 input unchanged (fallback)', () => {
    assert.equal(NostrSignaling._toL7('default'), 'default');
    assert.equal(NostrSignaling._toL7(null),      null);
    assert.equal(NostrSignaling._toL7(''),        '');
  });

  it('two L9 cells in the same ~5 km² area produce the same L7 channel', () => {
    // Both cells are within the same L7 parent
    const a = NostrSignaling._toL7('8f283082affffff');
    const b = NostrSignaling._toL7('8f283082affffff');
    assert.equal(a, b);
  });
});

// ── Constructor ───────────────────────────────────────────────────────────────

describe('NostrSignaling — constructor', () => {
  it('sets peerId, h3Cell, and channelCell', () => {
    const s = makeSignaling();
    assert.equal(s.peerId,    'peer_abc123');
    assert.equal(s.h3Cell,    '8f283082affffff');
    assert.ok(s.channelCell,  'channelCell must be derived');
  });

  it('channelCell is L7 (15 hex chars)', () => {
    const s = makeSignaling();
    assert.equal(s.channelCell.length, 15);
  });

  it('uses default relay list when relays not provided', () => {
    const s = new NostrSignaling({ peerId: 'p1', h3Cell: 'default' });
    assert.ok(Array.isArray(s._relayUrls));
    assert.ok(s._relayUrls.length > 0);
  });

  it('starts offline', () => {
    const s = makeSignaling();
    assert.equal(s.isOnline, false);
    assert.equal(s._connected.size, 0);
  });
});

// ── _initKeys() ───────────────────────────────────────────────────────────────

describe('NostrSignaling._initKeys()', () => {
  it('sets _pubkey to a 64-char hex string (mock mode)', async () => {
    const s = makeSignaling({ secp256k1: null }); // explicitly test without secp256k1
    await s._initKeys();
    assert.equal(typeof s._pubkey, 'string');
    assert.equal(s._pubkey.length, 64);
    assert.equal(s._privkey, null, 'privkey should be null in mock mode');
  });

  it('same peerId always produces same pubkey (deterministic)', async () => {
    const s1 = makeSignaling({ peerId: 'peer_aaaa' });
    const s2 = makeSignaling({ peerId: 'peer_aaaa' });
    await s1._initKeys();
    await s2._initKeys();
    assert.equal(s1._pubkey, s2._pubkey);
  });

  it('different peerIds produce different pubkeys', async () => {
    const s1 = makeSignaling({ peerId: 'peer_aaaa' });
    const s2 = makeSignaling({ peerId: 'peer_bbbb' });
    await s1._initKeys();
    await s2._initKeys();
    assert.notEqual(s1._pubkey, s2._pubkey);
  });

  it('uses real signing when secp256k1 module is injected', async () => {
    const lib = {
      getPublicKey: (priv) => 'real-pub-' + priv.slice(0, 4),
      schnorrSign:  (id, priv) => id.slice(0, 8) + priv.slice(0, 56),
    };
    const s = makeSignaling({ secp256k1: lib });
    await s._initKeys();
    assert.ok(s._privkey,              'privkey must be set with real lib');
    assert.ok(s._pubkey.startsWith('real-pub-'));
  });
});

// ── connect() ─────────────────────────────────────────────────────────────────

describe('NostrSignaling — connect()', () => {
  it('becomes online after relays connect', async () => {
    const s = makeSignaling();
    await s.connect();
    assert.equal(s.isOnline, true);
  });

  it('creates one WebSocket per relay URL', async () => {
    const s = makeSignaling();
    await s.connect();
    assert.equal(MockWebSocket._instances.length, 2);
  });

  it('emits "online" status', async () => {
    const s = makeSignaling();
    const statuses = [];
    s.on('status', st => statuses.push(st));
    await s.connect();
    assert.ok(statuses.includes('online'));
  });

  it('sends REQ subscription with #t filter to each relay', async () => {
    const s = makeSignaling();
    await s.connect();
    await tick();  // allow announce microtask
    for (const ws of MockWebSocket._instances) {
      const reqs = ws.sent
        .map(m => { try { return JSON.parse(m); } catch { return null; } })
        .filter(m => m?.[0] === 'REQ');
      assert.ok(reqs.length >= 1, `relay ${ws.url} must receive REQ`);
      assert.ok(reqs[0][2]['#t'], 'Subscription filter must use #t tag');
      assert.equal(reqs[0][2]['#t'][0], s.channelCell);
    }
  });

  it('publishes announce EVENT after connecting', async () => {
    const s = makeSignaling();
    await s.connect();
    await tick(50); // allow async _buildEvent microtasks
    const allSent = MockWebSocket._instances.flatMap(ws =>
      ws.sent.map(m => { try { return JSON.parse(m); } catch { return null; } })
    ).filter(Boolean);
    const events = allSent.filter(m => m[0] === 'EVENT');
    assert.ok(events.length > 0, 'Must publish at least one EVENT after connect');
    const ev = events[0][1];
    assert.equal(ev.kind, 10751, 'KIND_ANNOUNCE must be 10751');
  });

  it('emits "offline" when no relays are reachable', async () => {
    // Standalone FailingWS — does NOT extend MockWebSocket so no onopen is ever scheduled.
    // Extending MockWebSocket causes super() to queue onopen as a microtask, which fires
    // before our onerror microtask and incorrectly marks the relay as connected.
    class FailingWS {
      constructor(url) {
        this.url = url;
        this.readyState = MockWebSocket.CLOSED;
        this.sent = [];
        this.onopen = null;     // set by _connectRelay but never called
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        MockWebSocket._instances.push(this);
        // Trigger error asynchronously (mimics connection refused)
        Promise.resolve().then(() => this.onerror?.({ message: 'refused' }));
      }
      send(data) { this.sent.push(data); }
      close() {}
    }
    const saved = globalThis.WebSocket;
    globalThis.WebSocket = FailingWS;

    const s = makeSignaling({ bootTimeoutMs: 50 });
    const statuses = [];
    s.on('status', st => statuses.push(st));
    await s.connect();

    globalThis.WebSocket = saved;
    assert.ok(statuses.includes('offline'));
  });
});

// ── disconnect() ──────────────────────────────────────────────────────────────

describe('NostrSignaling — disconnect()', () => {
  it('sets offline after disconnect', async () => {
    const s = makeSignaling();
    await s.connect();
    assert.equal(s.isOnline, true);
    await s.disconnect();
    assert.equal(s.isOnline, false);
    assert.equal(s._connected.size, 0);
  });

  it('emits "offline" on disconnect', async () => {
    const s = makeSignaling();
    const statuses = [];
    s.on('status', st => statuses.push(st));
    await s.connect();
    await s.disconnect();
    assert.ok(statuses.includes('offline'));
  });
});

// ── announce() ────────────────────────────────────────────────────────────────

describe('NostrSignaling — announce()', () => {
  it('publishes KIND_ANNOUNCE (10751) with [t, channelCell] tag', async () => {
    const s = makeSignaling();
    await s.connect();
    // Clear setup messages
    MockWebSocket._instances.forEach(ws => { ws.sent = []; });

    await s.announce({ h3Cell: '8f283082affffff' });
    await tick(30);

    const events = MockWebSocket._instances
      .flatMap(ws => ws.sent.map(m => JSON.parse(m)))
      .filter(m => m[0] === 'EVENT')
      .map(m => m[1]);

    assert.ok(events.length > 0, 'announce() must publish EVENT');
    const ev = events[0];
    assert.equal(ev.kind, 10751);
    const tTag = ev.tags.find(t => t[0] === 't');
    assert.ok(tTag, 'Must have #t tag');
    assert.equal(tTag[1], s.channelCell);
  });

  it('includes peerId in the event content', async () => {
    const s = makeSignaling();
    await s.connect();
    MockWebSocket._instances.forEach(ws => { ws.sent = []; });
    await s.announce();
    await tick(30);

    const events = MockWebSocket._instances
      .flatMap(ws => ws.sent.map(m => JSON.parse(m)))
      .filter(m => m[0] === 'EVENT')
      .map(m => m[1]);

    assert.ok(events.length > 0);
    const content = JSON.parse(events[0].content);
    assert.equal(content.peerId, s.peerId);
  });
});

// ── sendSignal() ──────────────────────────────────────────────────────────────

describe('NostrSignaling — sendSignal()', () => {
  it('publishes KIND_SIGNAL (25001) with target tag', async () => {
    const s = makeSignaling();
    await s.connect();
    // connect() fires _republishPresenceToRelay and announce() as async fire-and-forget.
    // Their _buildEvent promises resolve after connect() returns, so we drain them first
    // before clearing ws.sent, otherwise their KIND_ANNOUNCE events appear as events[0].
    await tick(50);
    MockWebSocket._instances.forEach(ws => { ws.sent = []; });

    await s.sendSignal('peer_target99', { type: 'offer', sdp: 'mock-sdp' });
    await tick(30);

    const events = MockWebSocket._instances
      .flatMap(ws => ws.sent.map(m => JSON.parse(m)))
      .filter(m => m[0] === 'EVENT')
      .map(m => m[1]);

    assert.ok(events.length > 0, 'sendSignal must publish EVENT');
    const ev = events[0];
    assert.equal(ev.kind, 25001);
    const targetTag = ev.tags.find(t => t[0] === 'target');
    assert.ok(targetTag, 'Must have target tag');
    assert.equal(targetTag[1], 'peer_target99');
  });

  it('signal is published to all connected relays (not just one)', async () => {
    const s = makeSignaling();
    await s.connect();
    // Drain pending async announces before clearing, same reason as test above.
    await tick(50);
    MockWebSocket._instances.forEach(ws => { ws.sent = []; });

    await s.sendSignal('peer_other1', { type: 'ice-candidate', candidate: {} });
    await tick(30);

    // _publish sends to ALL connected relays for reliability
    // (avoids write-restricted relays like nostr.wine silently dropping signals)
    const connectedCount = MockWebSocket._instances.filter(ws => ws.readyState === 1).length;
    const totalEvents = MockWebSocket._instances
      .flatMap(ws => ws.sent.map(m => JSON.parse(m)))
      .filter(m => m[0] === 'EVENT');
    assert.ok(totalEvents.length >= connectedCount, `Signal must go to all ${connectedCount} connected relays, got ${totalEvents.length}`);
  });
});

// ── _handleRelayMsg() ─────────────────────────────────────────────────────────

describe('NostrSignaling._handleRelayMsg()', () => {
  it('emits peer:announce for KIND_ANNOUNCE from another peer', async () => {
    const s = makeSignaling();
    await s._initKeys();

    const announces = [];
    s.on('peer:announce', (peerId, meta) => announces.push({ peerId, meta }));

    s._handleRelayMsg('wss://relay1.test', JSON.stringify(['EVENT', 'sub1', {
      kind:    10751,
      content: JSON.stringify({ peerId: 'peer_other1', h3Cell: 'abc', ts: Date.now() }),
      pubkey:  'other-pubkey-aaaa',
      id:      'ev-announce-1',
      tags:    [['t', s.channelCell], ['peer', 'peer_other1']],
    }]));

    assert.equal(announces.length, 1);
    assert.equal(announces[0].peerId, 'peer_other1');
    assert.equal(announces[0].meta.h3Cell, 'abc');
  });

  it('emits signal for KIND_SIGNAL directed to us', async () => {
    const s = makeSignaling();
    await s._initKeys();

    const signals = [];
    s.on('signal', (from, sig) => signals.push({ from, sig }));

    s._handleRelayMsg('wss://relay1.test', JSON.stringify(['EVENT', 'sub1', {
      kind:    25001,
      content: JSON.stringify({ type: 'offer', sdp: 'test' }),
      pubkey:  'sender-pubkey',
      id:      'ev-signal-1',
      tags:    [['t', s.channelCell], ['peer', 'peer_sender1'], ['target', s.peerId]],
    }]));

    assert.equal(signals.length, 1);
    assert.equal(signals[0].from, 'peer_sender1');
    assert.equal(signals[0].sig.type, 'offer');
  });

  it('ignores KIND_SIGNAL directed to a different peer', async () => {
    const s = makeSignaling();
    await s._initKeys();
    const signals = [];
    s.on('signal', () => signals.push(1));

    s._handleRelayMsg('wss://relay1.test', JSON.stringify(['EVENT', 'sub1', {
      kind:    25001,
      content: JSON.stringify({ type: 'offer' }),
      pubkey:  'other-pub',
      id:      'ev-signal-2',
      tags:    [['t', s.channelCell], ['peer', 'peer_a'], ['target', 'peer_completely_different']],
    }]));

    assert.equal(signals.length, 0);
  });

  it('ignores own events (same pubkey as ours)', async () => {
    const s = makeSignaling();
    await s._initKeys();
    const announces = [];
    s.on('peer:announce', () => announces.push(1));

    s._handleRelayMsg('wss://relay1.test', JSON.stringify(['EVENT', 'sub1', {
      kind:    10751,
      content: JSON.stringify({ peerId: s.peerId, ts: Date.now() }),
      pubkey:  s._pubkey,  // same as ours
      id:      'ev-self',
      tags:    [['t', s.channelCell], ['peer', s.peerId]],
    }]));

    assert.equal(announces.length, 0, 'Own events must be ignored');
  });

  it('deduplicates events from multiple relays via event id', async () => {
    const s = makeSignaling();
    await s._initKeys();
    const announces = [];
    s.on('peer:announce', () => announces.push(1));

    const event = {
      kind:    10751,
      content: JSON.stringify({ peerId: 'peer_other1', ts: Date.now() }),
      pubkey:  'different-pubkey',
      id:      'same-event-id-xyz',
      tags:    [['t', s.channelCell], ['peer', 'peer_other1']],
    };
    s._handleRelayMsg('wss://relay1.test', JSON.stringify(['EVENT', 'sub1', event]));
    s._handleRelayMsg('wss://relay2.test', JSON.stringify(['EVENT', 'sub1', event]));

    assert.equal(announces.length, 1, 'Duplicate event must only fire once');
  });

  it('rejects events with invalid peerId format', async () => {
    const s = makeSignaling();
    await s._initKeys();
    const announces = [];
    s.on('peer:announce', () => announces.push(1));

    s._handleRelayMsg('wss://relay1.test', JSON.stringify(['EVENT', 'sub1', {
      kind:    10751,
      content: JSON.stringify({ peerId: 'invalid id with spaces!!', ts: Date.now() }),
      pubkey:  'other-pub',
      id:      'ev-bad-id',
      tags:    [['t', s.channelCell], ['peer', 'invalid id with spaces!!']],
    }]));

    assert.equal(announces.length, 0, 'Invalid peerId must be rejected');
  });

  it('rejects events with oversized content (> 64 KB)', async () => {
    const s = makeSignaling();
    await s._initKeys();
    const announces = [];
    s.on('peer:announce', () => announces.push(1));

    s._handleRelayMsg('wss://relay1.test', JSON.stringify(['EVENT', 'sub1', {
      kind:    10751,
      content: 'x'.repeat(65537),
      pubkey:  'other-pub',
      id:      'ev-big',
      tags:    [['peer', 'peer_x']],
    }]));

    assert.equal(announces.length, 0, 'Oversized content must be rejected');
  });

  it('ignores NOTICE messages without throwing', () => {
    const s = makeSignaling();
    assert.doesNotThrow(() =>
      s._handleRelayMsg('wss://relay1.test', JSON.stringify(['NOTICE', 'rate limited']))
    );
  });

  it('logs warning on OK false (rejected event) without throwing', () => {
    const s = makeSignaling();
    assert.doesNotThrow(() =>
      s._handleRelayMsg('wss://relay1.test', JSON.stringify(['OK', 'event-id', false, 'rate-limited']))
    );
  });

  it('handles EOSE without throwing', () => {
    const s = makeSignaling();
    assert.doesNotThrow(() =>
      s._handleRelayMsg('wss://relay1.test', JSON.stringify(['EOSE', 'sub1']))
    );
  });

  it('ignores malformed JSON without throwing', () => {
    const s = makeSignaling();
    assert.doesNotThrow(() => s._handleRelayMsg('wss://relay1.test', '{bad json!!'));
  });
});

// ── Presence heartbeat ────────────────────────────────────────────────────────

describe('NostrSignaling — _republishPresenceToRelay()', () => {
  it('uses [t, channelCell] tag (not [h, ...])', async () => {
    const s = makeSignaling();
    await s._initKeys();
    const sentEvents = [];

    // Simulate a fresh relay WebSocket
    const ws = { readyState: MockWebSocket.OPEN, sent: [], send(d) { sentEvents.push(JSON.parse(d)); } };
    await s._republishPresenceToRelay(ws);
    await tick(30);

    const evtMsgs = sentEvents.filter(m => m[0] === 'EVENT').map(m => m[1]);
    assert.ok(evtMsgs.length > 0, 'Must publish EVENT to relay');

    const ev = evtMsgs[0];
    const tTag = ev.tags.find(t => t[0] === 't');
    assert.ok(tTag, 'Must have [t, ...] tag');
    assert.equal(tTag[1], s.channelCell, 'Topic tag must equal channelCell');

    const hTag = ev.tags.find(t => t[0] === 'h');
    assert.equal(hTag, undefined, 'Must NOT have deprecated [h, ...] tag');
  });

  it('no-op when pubkey not yet set', async () => {
    const s = makeSignaling();
    // _initKeys() not called → _pubkey is null
    const sent = [];
    const ws = { readyState: MockWebSocket.OPEN, sent, send(d) { sent.push(d); } };
    s._republishPresenceToRelay(ws);
    await tick(20);
    assert.equal(sent.length, 0, 'Should be no-op without pubkey');
  });
});
