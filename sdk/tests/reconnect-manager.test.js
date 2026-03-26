/**
 * Tests for ReconnectManager — exponential backoff reconnect loop.
 * Run with: node --test sdk/tests/reconnect-manager.test.js
 *
 * All timing is controlled via config overrides so tests stay fast (< 100 ms each).
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import config from '../src/config.js';
import { ReconnectManager } from '../src/resilience/reconnect-manager.js';

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// Eliminate jitter by stubbing Math.random → 0 so delays are fully deterministic.
let _origRandom;
beforeEach(() => {
  _origRandom = Math.random;
  Math.random = () => 0;
  useFastConfig(3);
});
afterEach(() => { Math.random = _origRandom; });

// Shared config that keeps tests fast and deterministic
function useFastConfig(maxAttempts = 3) {
  config.set('transport.reconnectBaseDelay', 5);
  config.set('transport.reconnectMaxDelay',  50);
  config.set('transport.reconnectMaxAttempts', maxAttempts);
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('ReconnectManager — constructor', () => {
  it('throws when opts.reconnect is not a function', () => {
    assert.throws(() => new ReconnectManager({}), TypeError);
    assert.throws(() => new ReconnectManager({ reconnect: 42 }), TypeError);
  });

  it('constructs successfully when opts.reconnect is a function', () => {
    assert.doesNotThrow(() => new ReconnectManager({ reconnect: async () => {} }));
  });
});

// ── onDisconnect() ────────────────────────────────────────────────────────────

describe('ReconnectManager — onDisconnect()', () => {
  it('does nothing for empty / falsy peerId', () => {
    const mgr = new ReconnectManager({ reconnect: async () => {} });
    assert.doesNotThrow(() => mgr.onDisconnect(''));
    assert.doesNotThrow(() => mgr.onDisconnect(null));
    assert.doesNotThrow(() => mgr.onDisconnect(undefined));
  });

  it('schedules a reconnect attempt', async () => {
    const calls = [];
    const mgr   = new ReconnectManager({ reconnect: async id => calls.push(id) });

    mgr.onDisconnect('p1');
    await tick(30); // base=5ms + no jitter → fires well within 30ms

    assert.ok(calls.length >= 1, 'At least one reconnect attempt expected');
    assert.equal(calls[0], 'p1');
  });

  it('does not double-schedule for the same peer', async () => {
    useFastConfig(5);
    let callCount = 0;
    const mgr = new ReconnectManager({
      reconnect: async () => { callCount++; throw new Error('fail'); },
    });

    mgr.onDisconnect('p1');
    mgr.onDisconnect('p1'); // second call while timer is running → no-op
    await tick(20);

    // Should not have double-fired the timer
    assert.ok(callCount <= 2, 'Should not double-schedule');
  });

  it('handles multiple distinct peers independently', async () => {
    const calls = new Set();
    const mgr   = new ReconnectManager({ reconnect: async id => calls.add(id) });

    mgr.onDisconnect('alpha');
    mgr.onDisconnect('beta');
    await tick(30);

    assert.ok(calls.has('alpha'), 'alpha should have been attempted');
    assert.ok(calls.has('beta'),  'beta should have been attempted');
  });
});

// ── onConnect() ───────────────────────────────────────────────────────────────

describe('ReconnectManager — onConnect()', () => {
  it('emits "reconnected" event', async () => {
    const events = [];
    const mgr    = new ReconnectManager({ reconnect: async () => {} });
    mgr.on('reconnected', e => events.push(e));

    mgr.onDisconnect('p1');
    await tick(30);
    mgr.onConnect('p1');

    assert.ok(events.find(e => e.peerId === 'p1'));
  });

  it('resets attempt counter so peer can be reconnected again', async () => {
    const calls = [];
    const mgr   = new ReconnectManager({ reconnect: async id => calls.push(id) });

    // First disconnect + reconnect cycle
    mgr.onDisconnect('p1');
    await tick(30);
    mgr.onConnect('p1');

    const countAfterFirst = calls.length;

    // Second disconnect cycle
    mgr.onDisconnect('p1');
    await tick(30);

    assert.ok(calls.length > countAfterFirst, 'Second disconnect should start fresh reconnect cycle');
  });

  it('is a no-op for unknown peer', () => {
    const mgr = new ReconnectManager({ reconnect: async () => {} });
    assert.doesNotThrow(() => mgr.onConnect('never-seen'));
  });
});

// ── pause() / resume() ────────────────────────────────────────────────────────

describe('ReconnectManager — pause() / resume()', () => {
  it('pause() stops scheduled reconnects', async () => {
    let calls = 0;
    const mgr = new ReconnectManager({ reconnect: async () => { calls++; throw new Error('fail'); } });

    mgr.onDisconnect('p1');
    mgr.pause('p1'); // cancel before timer fires

    await tick(20);
    assert.equal(calls, 0, 'Paused manager should not have called reconnect');
  });

  it('resume() restarts attempts from zero', async () => {
    const calls = [];
    const mgr   = new ReconnectManager({ reconnect: async id => calls.push(id) });

    mgr.onDisconnect('p1');
    mgr.pause('p1');
    await tick(10); // nothing fires during pause

    mgr.resume('p1');
    await tick(30); // now should fire

    assert.ok(calls.length >= 1, 'resume() should restart reconnect attempts');
  });

  it('pause() is a no-op for unknown peer', () => {
    assert.doesNotThrow(() => new ReconnectManager({ reconnect: async () => {} }).pause('nobody'));
  });
});

// ── remove() ─────────────────────────────────────────────────────────────────

describe('ReconnectManager — remove()', () => {
  it('cancels pending timer and removes peer state', async () => {
    let calls = 0;
    const mgr = new ReconnectManager({ reconnect: async () => { calls++; throw new Error('fail'); } });

    mgr.onDisconnect('p1');
    mgr.remove('p1'); // cancel before timer fires

    await tick(20);
    assert.equal(calls, 0, 'Removed peer should not attempt reconnect');
  });

  it('is idempotent — remove() twice does not throw', () => {
    const mgr = new ReconnectManager({ reconnect: async () => {} });
    mgr.onDisconnect('p1');
    assert.doesNotThrow(() => { mgr.remove('p1'); mgr.remove('p1'); });
  });
});

// ── Give-up ───────────────────────────────────────────────────────────────────

describe('ReconnectManager — give-up', () => {
  it('emits "give-up" after maxAttempts are exhausted', async () => {
    useFastConfig(2); // small limit so the test finishes quickly
    const giveups = [];
    const mgr     = new ReconnectManager({
      // Always fail so attempts are exhausted
      reconnect: async () => { throw new Error('still down'); },
    });
    mgr.on('give-up', e => giveups.push(e));

    mgr.onDisconnect('p1');

    // 2 attempts × ~5+10ms base (no jitter) + overhead
    await tick(80);

    assert.ok(giveups.find(e => e.peerId === 'p1'), 'Should emit give-up after exhausting attempts');
  });

  it('removes peer state when giving up', async () => {
    useFastConfig(1); // 1 attempt only
    const mgr = new ReconnectManager({ reconnect: async () => { throw new Error('fail'); } });

    mgr.onDisconnect('p1');
    await tick(60);

    // After giving up, state is cleaned; calling onDisconnect should start fresh
    assert.doesNotThrow(() => mgr.onDisconnect('p1'));
  });

  it('does NOT emit give-up when reconnect succeeds before limit', async () => {
    useFastConfig(3);
    const giveups = [];
    const mgr     = new ReconnectManager({ reconnect: async id => { mgr.onConnect(id); } });
    mgr.on('give-up', e => giveups.push(e));

    mgr.onDisconnect('p1');
    await tick(40);

    assert.equal(giveups.length, 0, 'Should not give up when reconnect succeeds');
  });
});
