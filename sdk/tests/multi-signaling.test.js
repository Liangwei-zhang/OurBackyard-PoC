/**
 * Tests for MultiSignaling — priority-ordered failover across multiple backends.
 * Run with: node --test sdk/tests/multi-signaling.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MultiSignaling } from '../src/signaling/multi-signaling.js';
import { EventBus } from '../src/event-bus.js';

// ── Mock backend ──────────────────────────────────────────────────────────────

class MockBackend extends EventBus {
  constructor(id, { failInit = false } = {}) {
    super();
    this.id           = id;
    this._failInit    = failInit;
    this.initCalled   = false;
    this.announceCalls = 0;
    this.sentTo       = [];
    this.closeCalled  = false;
  }

  async init(localId) {
    this.initCalled = true;
    if (this._failInit) throw new Error(`Backend ${this.id} init failed`);
    this._localId = localId;
  }

  async announce() { this.announceCalls++; }

  sendToPeer(peerId, msg) { this.sentTo.push({ peerId, msg }); }

  close() { this.closeCalled = true; }
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('MultiSignaling — constructor', () => {
  it('throws if backends is not an array', () => {
    assert.throws(() => new MultiSignaling('not-array'), /backends must be a non-empty array/);
    assert.throws(() => new MultiSignaling(null),        /backends must be a non-empty array/);
  });

  it('throws if backends array is empty', () => {
    assert.throws(() => new MultiSignaling([]), /backends must be a non-empty array/);
  });

  it('creates with a valid backends array', () => {
    const ms = new MultiSignaling([new MockBackend('b1')]);
    assert.ok(ms);
  });
});

// ── init() ────────────────────────────────────────────────────────────────────

describe('MultiSignaling — init()', () => {
  it('throws if localId is falsy', async () => {
    const ms = new MultiSignaling([new MockBackend('b')]);
    await assert.rejects(() => ms.init(null),      /localId is required/);
    await assert.rejects(() => ms.init(undefined), /localId is required/);
  });

  it('calls init() on all backends', async () => {
    const b1 = new MockBackend('b1');
    const b2 = new MockBackend('b2');
    const ms = new MultiSignaling([b1, b2]);
    await ms.init('peer_x');
    assert.ok(b1.initCalled);
    assert.ok(b2.initCalled);
  });

  it('passes localId to all backends', async () => {
    const b1 = new MockBackend('b1');
    const ms = new MultiSignaling([b1]);
    await ms.init('peer_abc');
    assert.equal(b1._localId, 'peer_abc');
  });

  it('throws if ALL backends fail to initialise', async () => {
    const b1 = new MockBackend('fail1', { failInit: true });
    const b2 = new MockBackend('fail2', { failInit: true });
    const ms = new MultiSignaling([b1, b2]);
    await assert.rejects(() => ms.init('peer_x'), /All signaling backends failed/);
  });

  it('succeeds (partial init) when at least one backend succeeds', async () => {
    const b1 = new MockBackend('ok',   { failInit: false });
    const b2 = new MockBackend('bad',  { failInit: true  });
    const ms = new MultiSignaling([b1, b2]);
    await assert.doesNotReject(() => ms.init('peer_x'));
  });

  it('emits "connected" event after successful init()', async () => {
    const ms = new MultiSignaling([new MockBackend('b')]);
    const events = [];
    ms.on('connected', e => events.push(e));
    await ms.init('peer_x');
    assert.equal(events.length, 1);
  });
});

// ── Event forwarding ──────────────────────────────────────────────────────────

describe('MultiSignaling — event forwarding', () => {
  it('forwards peer:announce from any backend', async () => {
    const b1 = new MockBackend('b1');
    const ms = new MultiSignaling([b1]);
    await ms.init('peer_x');

    const announces = [];
    ms.on('peer:announce', (data) => announces.push(data));

    b1.emit('peer:announce', { peerId: 'peer_other' });
    assert.equal(announces.length, 1);
    assert.equal(announces[0].peerId, 'peer_other');
  });

  it('forwards peer:announce from both backends', async () => {
    const b1 = new MockBackend('b1');
    const b2 = new MockBackend('b2');
    const ms = new MultiSignaling([b1, b2]);
    await ms.init('peer_x');

    const announces = [];
    ms.on('peer:announce', (data) => announces.push(data));

    b1.emit('peer:announce', { peerId: 'peer_A' });
    b2.emit('peer:announce', { peerId: 'peer_B' });
    assert.equal(announces.length, 2);
  });

  it('deduplicates identical signals from multiple backends', async () => {
    const b1 = new MockBackend('b1');
    const b2 = new MockBackend('b2');
    const ms = new MultiSignaling([b1, b2]);
    await ms.init('peer_x');

    const signals = [];
    ms.on('signal', (data) => signals.push(data));

    const sigData = { from: 'peer_other', msg: { type: 'offer', sdp: 'same-sdp' } };
    b1.emit('signal', sigData);
    b2.emit('signal', sigData); // identical → should be deduped

    assert.equal(signals.length, 1, 'Duplicate signal must only be forwarded once');
  });

  it('forwards distinct signals separately', async () => {
    const b1 = new MockBackend('b1');
    const ms = new MultiSignaling([b1]);
    await ms.init('peer_x');

    const signals = [];
    ms.on('signal', (data) => signals.push(data));

    b1.emit('signal', { from: 'p1', msg: { type: 'offer',     sdp: 'sdp-1' } });
    b1.emit('signal', { from: 'p2', msg: { type: 'ice-candidate', candidate: 'c1' } });

    assert.equal(signals.length, 2);
  });

  it('forwards "connected" and "disconnected" events from backends', async () => {
    const b1 = new MockBackend('b1');
    const ms = new MultiSignaling([b1]);
    await ms.init('peer_x');

    const events = [];
    ms.on('connected',    e => events.push('conn:' + (e.backend ?? '')));
    ms.on('disconnected', e => events.push('disc:' + (e.backend ?? '')));

    b1.emit('connected', {});
    b1.emit('disconnected', {});

    assert.ok(events.some(e => e.startsWith('conn:')));
    assert.ok(events.some(e => e.startsWith('disc:')));
  });

  it('seen-set is trimmed when it grows beyond 1000 entries', async () => {
    const b1 = new MockBackend('b1');
    const ms = new MultiSignaling([b1]);
    await ms.init('peer_x');

    // Emit > 1000 distinct signals to trigger trim
    for (let i = 0; i < 1100; i++) {
      b1.emit('signal', { from: 'p1', msg: { type: 'ice-candidate', i } });
    }

    assert.ok(ms._seenSignals.size <= 1000, 'seenSignals must be capped at 1000');
  });
});

// ── announce() ────────────────────────────────────────────────────────────────

describe('MultiSignaling — announce()', () => {
  it('calls announce() on all backends', async () => {
    const b1 = new MockBackend('b1');
    const b2 = new MockBackend('b2');
    const ms = new MultiSignaling([b1, b2]);
    await ms.init('peer_x');

    await ms.announce();

    assert.equal(b1.announceCalls, 1);
    assert.equal(b2.announceCalls, 1);
  });
});

// ── sendToPeer() ──────────────────────────────────────────────────────────────

describe('MultiSignaling — sendToPeer()', () => {
  it('calls sendToPeer() on all backends', async () => {
    const b1 = new MockBackend('b1');
    const b2 = new MockBackend('b2');
    const ms = new MultiSignaling([b1, b2]);
    await ms.init('peer_x');

    ms.sendToPeer('peer_target', { type: 'ice-candidate' });

    assert.equal(b1.sentTo.length, 1);
    assert.equal(b2.sentTo.length, 1);
    assert.equal(b1.sentTo[0].peerId, 'peer_target');
  });

  it('continues even if one backend throws', async () => {
    const b1 = new MockBackend('b1');
    const b2 = new MockBackend('b2');
    b1.sendToPeer = () => { throw new Error('backend 1 send failed'); };
    const ms = new MultiSignaling([b1, b2]);
    await ms.init('peer_x');

    assert.doesNotThrow(() => ms.sendToPeer('peer_t', { type: 'offer' }));
    // b2 should still receive the message
    assert.equal(b2.sentTo.length, 1);
  });
});

// ── close() ───────────────────────────────────────────────────────────────────

describe('MultiSignaling — close()', () => {
  it('calls close() on all backends', async () => {
    const b1 = new MockBackend('b1');
    const b2 = new MockBackend('b2');
    const ms = new MultiSignaling([b1, b2]);
    await ms.init('peer_x');

    ms.close();

    assert.ok(b1.closeCalled);
    assert.ok(b2.closeCalled);
  });

  it('close() is idempotent (no throw on double close)', async () => {
    const b1 = new MockBackend('b1');
    const ms = new MultiSignaling([b1]);
    await ms.init('peer_x');
    ms.close();
    assert.doesNotThrow(() => ms.close());
  });
});
