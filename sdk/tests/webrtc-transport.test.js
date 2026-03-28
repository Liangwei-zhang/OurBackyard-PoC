/**
 * Tests for WebRTCTransport — RTCPeerConnection lifecycle + DataChannel management.
 * Run with: node --test sdk/tests/webrtc-transport.test.js
 *
 * RTCPeerConnection, RTCDataChannel, RTCSessionDescription, and RTCIceCandidate
 * are mocked globally so no real WebRTC stack is required.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, before, after } from 'node:test';
import { WebRTCTransport } from '../src/transport/webrtc-transport.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

class MockDataChannel {
  constructor(label) {
    this.label       = label;
    this.readyState  = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType  = '';
    this.sent        = [];
    this.onopen      = null;
    this.onclose     = null;
    this.onmessage   = null;
  }

  send(data)       { if (this.readyState !== 'open') throw new DOMException('not open'); this.sent.push(data); }
  _open()          { this.readyState = 'open';   this.onopen?.(); }
  _close()         { this.readyState = 'closed'; this.onclose?.(); }
  _deliver(data)   { this.onmessage?.({ data }); }
}

class MockRTCPeerConnection {
  constructor(config) {
    this._config            = config;
    this.signalingState     = 'stable';
    this.connectionState    = 'new';
    this.iceConnectionState = 'new';
    this.localDescription   = null;
    this.onicecandidate     = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.ondatachannel      = null;
    this._dc                = null;
    this._closed            = false;
    MockRTCPeerConnection._instances.push(this);
  }

  async createOffer(opts)  { return { type: 'offer',  sdp: 'mock-offer-sdp'  }; }
  async createAnswer()     { return { type: 'answer', sdp: 'mock-answer-sdp' }; }

  async setLocalDescription(desc) {
    this.localDescription = desc;
    if (desc.type === 'offer')    this.signalingState = 'have-local-offer';
    else if (desc.type === 'rollback') this.signalingState = 'stable';
    else                          this.signalingState = 'stable';
  }

  async setRemoteDescription(desc) {
    if (desc.type === 'offer')  this.signalingState = 'have-remote-offer';
    else                        this.signalingState = 'stable';
  }

  async addIceCandidate(c) {}

  createDataChannel(name) {
    this._dc = new MockDataChannel(name);
    return this._dc;
  }

  close() { this._closed = true; this.connectionState = 'closed'; }

  /** Simulate state transition */
  _setState(connState) {
    this.connectionState = connState;
    this.onconnectionstatechange?.();
  }

  _setIceState(iceState) {
    this.iceConnectionState = iceState;
    this.oniceconnectionstatechange?.();
  }

  static _instances = [];
  static reset()    { MockRTCPeerConnection._instances = []; }
  static last()     { return MockRTCPeerConnection._instances[MockRTCPeerConnection._instances.length - 1]; }
}

class MockRTCSessionDescription {
  constructor(d) { this.type = d.type; this.sdp = d.sdp; }
}

class MockRTCIceCandidate {
  constructor(c) { Object.assign(this, c); }
}

// Install / remove globals
before(() => {
  globalThis.RTCPeerConnection     = MockRTCPeerConnection;
  globalThis.RTCSessionDescription = MockRTCSessionDescription;
  globalThis.RTCIceCandidate       = MockRTCIceCandidate;
});
after(() => {
  delete globalThis.RTCPeerConnection;
  delete globalThis.RTCSessionDescription;
  delete globalThis.RTCIceCandidate;
});
beforeEach(() => MockRTCPeerConnection.reset());

// ── Helper ────────────────────────────────────────────────────────────────────

function makeTransport(overrides = {}) {
  return new WebRTCTransport({ peerId: 'local-peer', iceServers: [], ...overrides });
}

/**
 * Open a data channel for a peer directly via _setupDataChannel + _open().
 */
function openChannel(transport, peerId) {
  const dc = new MockDataChannel('mesh');
  transport._setupDataChannel(peerId, dc);
  dc._open();
  return dc;
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('WebRTCTransport — constructor', () => {
  it('starts with zero peers', () => {
    const t = makeTransport();
    assert.equal(t.peerCount, 0);
    assert.deepEqual(t.connectedPeers, []);
  });

  it('stores peerId', () => {
    assert.equal(makeTransport().peerId, 'local-peer');
  });

  it('stores iceServers', () => {
    const ice = [{ urls: 'stun:test' }];
    const t   = makeTransport({ iceServers: ice });
    assert.deepEqual(t.iceServers, ice);
  });

  it('hasPeerConnection() returns false for unknown peer', () => {
    assert.equal(makeTransport().hasPeerConnection('nobody'), false);
  });

  it('getDataChannel() returns null for unknown peer', () => {
    assert.equal(makeTransport().getDataChannel('nobody'), null);
  });
});

// ── createOffer() ─────────────────────────────────────────────────────────────

describe('WebRTCTransport — createOffer()', () => {
  it('creates an RTCPeerConnection and emits offer signal', async () => {
    const t       = makeTransport();
    const signals = [];
    t.on('signal:send', (target, sig) => signals.push({ target, sig }));

    await t.createOffer('remote-peer');

    assert.equal(signals.length, 1);
    assert.equal(signals[0].target,    'remote-peer');
    assert.equal(signals[0].sig.type,  'offer');
    assert.ok(signals[0].sig.sdp,     'Signal must include SDP');
  });

  it('does not create duplicate connection to same peer', async () => {
    const t = makeTransport();
    t.on('signal:send', () => {});
    await t.createOffer('remote-peer');
    await t.createOffer('remote-peer'); // should be no-op
    assert.equal(MockRTCPeerConnection._instances.length, 1);
  });

  it('respects maxPeers limit', async () => {
    const t = makeTransport({ maxPeers: 2 });
    t.on('signal:send', () => {});
    await t.createOffer('peer-a');
    await t.createOffer('peer-b');
    await t.createOffer('peer-c'); // should be rejected
    assert.equal(MockRTCPeerConnection._instances.length, 2);
  });

  it('cleans up failed connection and re-offers (zombie cleanup)', async () => {
    const t = makeTransport();
    const signals = [];
    t.on('signal:send', (target, sig) => signals.push({ target, sig }));

    // First offer — creates a PC
    await t.createOffer('remote-peer');
    assert.equal(signals.length, 1);

    // Simulate ICE failure: mark the existing PC as failed
    const failedPC = MockRTCPeerConnection._instances[0];
    failedPC.connectionState = 'failed';
    // Manually register it in _peerConns (mock createOffer does this via _newPC)
    // The PC is already in _peerConns from the first offer call.

    // Second offer — should detect 'failed' state, clean up, and re-offer
    MockRTCPeerConnection._instances.length = 0; // reset instance tracking
    await t.createOffer('remote-peer');
    assert.equal(signals.length, 2, 'Should emit a second offer signal after cleanup');
    assert.equal(signals[1].sig.type, 'offer');
  });
});

// ── connect() ─────────────────────────────────────────────────────────────────

describe('WebRTCTransport — connect()', () => {
  it('creates offer when shouldOffer=true (default)', async () => {
    const t       = makeTransport();
    const signals = [];
    t.on('signal:send', (target, sig) => signals.push(sig));
    await t.connect('remote-peer', true);
    assert.ok(signals.find(s => s.type === 'offer'));
  });

  it('tracks peer without creating offer when shouldOffer=false', async () => {
    const t = makeTransport();
    t.on('signal:send', () => {});
    await t.connect('remote-peer', false);
    // No RTCPeerConnection should be created
    assert.equal(MockRTCPeerConnection._instances.length, 0);
    assert.ok(t._peerMeta.has('remote-peer'));
  });
});

// ── handleSignal() ────────────────────────────────────────────────────────────

describe('WebRTCTransport — handleSignal()', () => {
  it('handles offer and emits answer signal', async () => {
    const t       = makeTransport();
    const signals = [];
    t.on('signal:send', (target, sig) => signals.push({ target, sig }));

    await t.handleSignal('remote-peer', {
      type: 'offer',
      sdp:  { type: 'offer', sdp: 'remote-sdp' },
    });

    const answer = signals.find(s => s.sig.type === 'answer');
    assert.ok(answer, 'Must emit answer signal');
    assert.equal(answer.target, 'remote-peer');
  });

  it('handles answer without throwing', async () => {
    const t = makeTransport();
    t.on('signal:send', () => {});
    await t.createOffer('remote-peer');

    await assert.doesNotReject(() =>
      t.handleSignal('remote-peer', {
        type: 'answer',
        sdp:  { type: 'answer', sdp: 'mock-answer' },
      })
    );
  });

  it('accepts re-offer in stable state when no DataChannel is open', async () => {
    const t = makeTransport();
    const signals = [];
    t.on('signal:send', (target, sig) => signals.push({ target, sig }));

    // First offer creates a PC and sends answer.
    await t.handleSignal('remote-peer', {
      type: 'offer',
      sdp:  { type: 'offer', sdp: 'remote-sdp-1' },
    });
    const firstPc = t._peerConns.get('remote-peer');
    assert.ok(firstPc, 'first peer connection should exist');

    // Simulate "stable but no open data channel" case.
    firstPc.signalingState = 'stable';

    // Second offer should replace stale PC and emit another answer.
    await t.handleSignal('remote-peer', {
      type: 'offer',
      sdp:  { type: 'offer', sdp: 'remote-sdp-2' },
    });

    const secondPc = t._peerConns.get('remote-peer');
    assert.notEqual(secondPc, firstPc, 'stale stable PC should be replaced when no open DC exists');
    assert.equal(firstPc._closed, true, 'old PC should be closed');
    const answers = signals.filter(s => s.sig.type === 'answer');
    assert.ok(answers.length >= 2, 'should answer re-offer instead of ignoring it');
  });

  it('ignores duplicate answers (not in have-local-offer state)', async () => {
    const t = makeTransport();
    t.on('signal:send', () => {});
    await t.createOffer('remote-peer');
    // Apply the answer once (moves to 'stable')
    await t.handleSignal('remote-peer', { type: 'answer', sdp: { type: 'answer', sdp: 'ans' } });
    // Second identical answer must be a no-op
    await assert.doesNotReject(() =>
      t.handleSignal('remote-peer', { type: 'answer', sdp: { type: 'answer', sdp: 'ans' } })
    );
  });

  it('handles ice-candidate without throwing', async () => {
    const t = makeTransport();
    t.on('signal:send', () => {});
    await t.createOffer('remote-peer');
    await assert.doesNotReject(() =>
      t.handleSignal('remote-peer', {
        type:      'ice-candidate',
        candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      })
    );
  });

  it('ignores ice-candidate for unknown peer', async () => {
    const t = makeTransport();
    await assert.doesNotReject(() =>
      t.handleSignal('unknown', { type: 'ice-candidate', candidate: { candidate: 'x' } })
    );
  });
});

// ── Data channel lifecycle ────────────────────────────────────────────────────

describe('WebRTCTransport — data channel lifecycle', () => {
  it('emits "peer:connected" when channel opens', () => {
    const t      = makeTransport();
    const joined = [];
    t.on('peer:connected', pid => joined.push(pid));

    openChannel(t, 'remote-peer');
    assert.ok(joined.includes('remote-peer'));
  });

  it('emits "peer:disconnected" when channel closes', () => {
    const t    = makeTransport();
    const left = [];
    t.on('peer:disconnected', pid => left.push(pid));

    const dc = openChannel(t, 'remote-peer');
    dc._close();

    assert.ok(left.includes('remote-peer'));
  });

  it('peerCount increments / decrements correctly', () => {
    const t = makeTransport();
    t.on('signal:send', () => {});

    const dc1 = openChannel(t, 'p1');
    const dc2 = openChannel(t, 'p2');
    assert.equal(t.peerCount, 2);

    dc1._close();
    assert.equal(t.peerCount, 1);
  });

  it('emits "data" event when message arrives', () => {
    const t    = makeTransport();
    const msgs = [];
    t.on('data', (pid, data) => msgs.push({ pid, data }));

    const dc = openChannel(t, 'remote-peer');
    dc._deliver('{"type":"PING"}');

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].pid,  'remote-peer');
    assert.equal(msgs[0].data, '{"type":"PING"}');
  });

  it('getDataChannel() returns open channel', () => {
    const t = makeTransport();
    openChannel(t, 'p1');
    assert.ok(t.getDataChannel('p1'));
  });
});

// ── send() / broadcast() ──────────────────────────────────────────────────────

describe('WebRTCTransport — send() / broadcast()', () => {
  it('send() returns false when no connection exists', () => {
    assert.equal(makeTransport().send('nobody', 'data'), false);
  });

  it('send() returns true and delivers data when channel is open', () => {
    const t  = makeTransport();
    const dc = openChannel(t, 'p1');

    const result = t.send('p1', 'hello');
    assert.equal(result, true);
    assert.ok(dc.sent.includes('hello'));
  });

  it('send() returns false when bufferedAmount >= maxBuffer', () => {
    const t  = makeTransport({ maxBuffer: 100 });
    const dc = openChannel(t, 'p1');
    dc.bufferedAmount = 100; // at threshold

    assert.equal(t.send('p1', 'data'), false);
  });

  it('broadcast() sends to all open channels', () => {
    const t   = makeTransport();
    const dc1 = openChannel(t, 'p1');
    const dc2 = openChannel(t, 'p2');

    t.broadcast('ping-all');

    assert.ok(dc1.sent.includes('ping-all'));
    assert.ok(dc2.sent.includes('ping-all'));
  });

  it('broadcast() excludes specified peer', () => {
    const t   = makeTransport();
    const dc1 = openChannel(t, 'p1');
    const dc2 = openChannel(t, 'p2');

    t.broadcast('msg', 'p1');

    assert.equal(dc1.sent.length, 0, 'p1 should be excluded');
    assert.ok(dc2.sent.includes('msg'));
  });
});

// ── Glare resolution ──────────────────────────────────────────────────────────

describe('WebRTCTransport — glare resolution', () => {
  it('higher-peerId peer rolls back and answers incoming offer', async () => {
    // local='z-peer', remote='a-peer' → z > a → local must roll back and answer
    const t       = new WebRTCTransport({ peerId: 'z-peer', iceServers: [] });
    const signals = [];
    t.on('signal:send', (target, sig) => signals.push({ target, sig }));

    await t.createOffer('a-peer');  // sends offer, signalingState = have-local-offer
    await t.handleSignal('a-peer', { type: 'offer', sdp: { type: 'offer', sdp: 'their-sdp' } });

    const answer = signals.find(s => s.sig.type === 'answer');
    assert.ok(answer, 'Higher-peerId side should roll back and send answer');
  });

  it('lower-peerId peer wins glare — ignores incoming offer', async () => {
    // local='a-peer', remote='z-peer' → a < z → local wins → ignore their offer
    const t       = new WebRTCTransport({ peerId: 'a-peer', iceServers: [] });
    const signals = [];
    t.on('signal:send', (target, sig) => signals.push({ target, sig }));

    await t.createOffer('z-peer');
    const offerCount = signals.length;

    // Receive offer from z-peer (glare) — local wins, should ignore
    await t.handleSignal('z-peer', { type: 'offer', sdp: { type: 'offer', sdp: 'their-sdp' } });

    const answers = signals.filter(s => s.sig.type === 'answer');
    assert.equal(answers.length, 0, 'Lower-peerId peer should not answer (won glare)');
  });
});

// ── ICE restart ───────────────────────────────────────────────────────────────

describe('WebRTCTransport — ICE failure / connection state changes', () => {
  it('triggers ICE restart (new offer) when ice state = failed and we are offerer', async () => {
    const t       = new WebRTCTransport({ peerId: 'a-peer', iceServers: [] });
    const signals = [];
    t.on('signal:send', (target, sig) => signals.push({ target, sig }));

    await t.createOffer('z-peer');  // a < z → a is offerer
    const initCount = signals.length;

    const pc = MockRTCPeerConnection.last();
    pc._setIceState('failed'); // simulate ICE failure

    await new Promise(r => setTimeout(r, 20)); // let async restart settle

    const newOffers = signals.slice(initCount).filter(s => s.sig.type === 'offer');
    assert.ok(newOffers.length >= 1, 'ICE failure should trigger a new offer for ICE restart');
  });

  it('cleans peer on connection state = failed', async () => {
    const t = makeTransport({ reconnectMs: 999999 }); // disable reconnect
    t.on('signal:send', () => {});
    await t.createOffer('remote-peer');

    const pc = MockRTCPeerConnection.last();
    pc._setState('failed');

    assert.equal(t.hasPeerConnection('remote-peer'), false, 'Failed peer should be cleaned up');
  });
});

// ── disconnect() / destroy() ──────────────────────────────────────────────────

describe('WebRTCTransport — disconnect() / destroy()', () => {
  it('disconnect() removes the peer connection', async () => {
    const t = makeTransport();
    t.on('signal:send', () => {});
    await t.createOffer('p1');

    t.disconnect('p1');
    assert.equal(t.hasPeerConnection('p1'), false);
  });

  it('disconnect() is a no-op for unknown peer', () => {
    assert.doesNotThrow(() => makeTransport().disconnect('nobody'));
  });

  it('destroyAll() clears all peers and channels', () => {
    const t = makeTransport();
    openChannel(t, 'p1');
    openChannel(t, 'p2');

    t.destroyAll();
    assert.equal(t.peerCount, 0);
    assert.equal(t.connectedPeers.length, 0);
  });

  it('peers() returns list of connected peer IDs', () => {
    const t = makeTransport();
    openChannel(t, 'p1');
    openChannel(t, 'p2');
    const p = t.peers();
    assert.ok(p.includes('p1'));
    assert.ok(p.includes('p2'));
  });
});
