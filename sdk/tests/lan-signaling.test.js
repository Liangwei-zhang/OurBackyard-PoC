/**
 * Tests for LANSignaling — local-network peer discovery via BroadcastChannel.
 * Run with: node --test sdk/tests/lan-signaling.test.js
 *
 * BroadcastChannel is mocked globally for cross-instance delivery.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, before, after } from 'node:test';
import { LANSignaling } from '../src/signaling/lan-signaling.js';
import config from '../src/config.js';

// ── MockBroadcastChannel ──────────────────────────────────────────────────────

class MockBroadcastChannel {
  constructor(name) {
    this.name      = name;
    this.onmessage = null;
    this.closed    = false;
    MockBroadcastChannel._registry.push(this);
  }

  postMessage(data) {
    // Deliver to all OTHER open channels with the same name (async, like real BroadcastChannel)
    Promise.resolve().then(() => {
      MockBroadcastChannel._registry.forEach(ch => {
        if (ch !== this && !ch.closed && ch.name === this.name) {
          ch.onmessage?.({ data });
        }
      });
    });
  }

  close() {
    this.closed = true;
  }

  static _registry = [];
  static reset() { MockBroadcastChannel._registry = []; }
}

let _origBC;
before(()  => { _origBC = globalThis.BroadcastChannel; globalThis.BroadcastChannel = MockBroadcastChannel; });
after(()   => { globalThis.BroadcastChannel = _origBC; });
beforeEach(() => { MockBroadcastChannel.reset(); config.reset(); });

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// ── init() ────────────────────────────────────────────────────────────────────

describe('LANSignaling — init()', () => {
  it('throws if localId is missing', async () => {
    const s = new LANSignaling();
    await assert.rejects(() => s.init(null),      /localId is required/);
    await assert.rejects(() => s.init(undefined), /localId is required/);
  });

  it('throws if BroadcastChannel is not available', async () => {
    const saved = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = undefined;
    const s = new LANSignaling();
    await assert.rejects(() => s.init('peer_a'), /BroadcastChannel is not supported/);
    globalThis.BroadcastChannel = saved;
  });

  it('sets localId after init()', async () => {
    const s = new LANSignaling({ channel: 'ch-init-1' });
    await s.init('peer_a');
    assert.equal(s._localId, 'peer_a');
    s.close();
  });

  it('emits "connected" on successful init()', async () => {
    const events = [];
    const s = new LANSignaling({ channel: 'ch-init-2' });
    s.on('connected', e => events.push(e));
    await s.init('peer_a');
    assert.equal(events.length, 1);
    s.close();
  });

  it('creates BroadcastChannel with CHANNEL_PREFIX + channel name', async () => {
    const s = new LANSignaling({ channel: 'testchan' });
    await s.init('p1');
    assert.ok(s._bc.name.includes('testchan'));
    s.close();
  });
});

// ── announce() ────────────────────────────────────────────────────────────────

describe('LANSignaling — announce()', () => {
  it('other peer receives peer:announce event', async () => {
    config.set('signaling.announceIntervalMs', 60000); // prevent timer noise

    const s1 = new LANSignaling({ channel: 'ch-ann-1' });
    const s2 = new LANSignaling({ channel: 'ch-ann-1' });
    await s1.init('peer_a');
    await s2.init('peer_b');

    const announcements = [];
    s2.on('peer:announce', data => announcements.push(data));

    await s1.announce();
    await tick();

    assert.equal(announcements.length, 1);
    assert.equal(announcements[0].peerId, 'peer_a');

    s1.close(); s2.close();
  });

  it('does not deliver announce to self', async () => {
    config.set('signaling.announceIntervalMs', 60000);

    const s = new LANSignaling({ channel: 'ch-ann-2' });
    await s.init('peer_solo');

    const announcements = [];
    s.on('peer:announce', d => announcements.push(d));

    await s.announce();
    await tick();

    assert.equal(announcements.length, 0, 'Self-announce must be ignored');
    s.close();
  });

  it('peers on different channels do not interfere', async () => {
    config.set('signaling.announceIntervalMs', 60000);

    const sA1 = new LANSignaling({ channel: 'ch-A' });
    const sB1 = new LANSignaling({ channel: 'ch-B' });
    await sA1.init('peer_A1');
    await sB1.init('peer_B1');

    const annB = [];
    sB1.on('peer:announce', d => annB.push(d));

    await sA1.announce(); // only on ch-A
    await tick();

    assert.equal(annB.length, 0, 'Different-channel announce must not cross-contaminate');
    sA1.close(); sB1.close();
  });
});

// ── sendToPeer() ──────────────────────────────────────────────────────────────

describe('LANSignaling — sendToPeer()', () => {
  it('delivers "signal" event to the target peer only', async () => {
    const s1 = new LANSignaling({ channel: 'ch-stp-1' });
    const s2 = new LANSignaling({ channel: 'ch-stp-1' });
    const s3 = new LANSignaling({ channel: 'ch-stp-1' });
    await s1.init('peer_a');
    await s2.init('peer_b');
    await s3.init('peer_c');

    const sigB = []; const sigC = [];
    s2.on('signal', d => sigB.push(d));
    s3.on('signal', d => sigC.push(d));

    s1.sendToPeer('peer_b', { type: 'offer', sdp: 'test' });
    await tick();

    assert.equal(sigB.length, 1, 'peer_b should receive signal');
    assert.equal(sigC.length, 0, 'peer_c should NOT receive signal for peer_b');
    assert.equal(sigB[0].from, 'peer_a');
    assert.deepEqual(sigB[0].msg, { type: 'offer', sdp: 'test' });

    s1.close(); s2.close(); s3.close();
  });

  it('does not deliver if BroadcastChannel is closed', async () => {
    const s = new LANSignaling({ channel: 'ch-stp-2' });
    await s.init('peer_a');
    s.close(); // Close before sending
    assert.doesNotThrow(() => s.sendToPeer('peer_b', { type: 'offer' }));
  });
});

// ── close() ───────────────────────────────────────────────────────────────────

describe('LANSignaling — close()', () => {
  it('marks BroadcastChannel as closed', async () => {
    const s = new LANSignaling({ channel: 'ch-close-1' });
    await s.init('peer_a');
    s.close();
    assert.equal(s._bc, null, '_bc should be null after close');
  });

  it('stops the announce timer', async () => {
    config.set('signaling.announceIntervalMs', 60000);
    const s = new LANSignaling({ channel: 'ch-close-2' });
    await s.init('peer_a');
    await s.announce();
    s.close();
    assert.equal(s._announceTimer, null, 'Timer should be cleared');
  });

  it('emits "disconnected" on close', async () => {
    const s = new LANSignaling({ channel: 'ch-close-3' });
    await s.init('peer_a');
    const events = [];
    s.on('disconnected', e => events.push(e));
    s.close();
    assert.equal(events.length, 1);
  });

  it('close() is idempotent (double-close does not throw)', async () => {
    const s = new LANSignaling({ channel: 'ch-close-4' });
    await s.init('peer_a');
    s.close();
    assert.doesNotThrow(() => s.close());
  });
});

// ── Message validation ────────────────────────────────────────────────────────

describe('LANSignaling — incoming message validation', () => {
  it('ignores null or non-object messages', async () => {
    const s = new LANSignaling({ channel: 'ch-val-1' });
    await s.init('peer_a');
    assert.doesNotThrow(() => s._handleMessage(null));
    assert.doesNotThrow(() => s._handleMessage('not-an-object'));
    assert.doesNotThrow(() => s._handleMessage(42));
    s.close();
  });

  it('ignores signals addressed to a different peer', async () => {
    const s = new LANSignaling({ channel: 'ch-val-2' });
    await s.init('peer_a');
    const signals = [];
    s.on('signal', d => signals.push(d));

    s._handleMessage({ type: 'signal', from: 'p2', to: 'peer_zzz', msg: {} });
    assert.equal(signals.length, 0);
    s.close();
  });
});
