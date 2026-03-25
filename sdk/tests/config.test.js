/**
 * Tests for Config — global configuration registry.
 * Run with: node --test sdk/tests/config.test.js
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { Config } from '../src/config.js';

describe('Config', () => {
  let cfg;
  beforeEach(() => { cfg = new Config(); });

  it('get() returns default values', () => {
    assert.equal(cfg.get('router.dedupCapacity'), 50000);
    assert.equal(cfg.get('transport.reconnectMaxAttempts'), 10);
  });

  it('get() returns fallback for unknown keys', () => {
    assert.equal(cfg.get('no.such.key', 42), 42);
  });

  it('set() updates value', () => {
    cfg.set('gossip.ttl', 10);
    assert.equal(cfg.get('gossip.ttl'), 10);
  });

  it('set() emits "change" event', () => {
    const events = [];
    cfg.on('change', e => events.push(e));
    cfg.set('gossip.ttl', 7);
    assert.equal(events[0].key, 'gossip.ttl');
    assert.equal(events[0].newValue, 7);
  });

  it('set() throws RangeError for invalid value (validator)', () => {
    assert.throws(() => cfg.set('router.dedupCapacity', -1), RangeError);
    assert.throws(() => cfg.set('router.dedupCapacity', 2), RangeError);
  });

  it('merge() applies multiple overrides', () => {
    cfg.merge({ 'gossip.ttl': 8, 'gossip.fanout': 5 });
    assert.equal(cfg.get('gossip.ttl'), 8);
    assert.equal(cfg.get('gossip.fanout'), 5);
  });

  it('reset() restores defaults', () => {
    cfg.set('gossip.ttl', 99);
    cfg.reset();
    assert.equal(cfg.get('gossip.ttl'), 5);
  });

  it('reset() emits "reset" event', () => {
    const events = [];
    cfg.on('reset', e => events.push(e));
    cfg.reset();
    assert.equal(events.length, 1);
  });

  it('snapshot() returns a copy of current config', () => {
    cfg.set('gossip.ttl', 3);
    const snap = cfg.snapshot();
    assert.equal(snap['gossip.ttl'], 3);
    snap['gossip.ttl'] = 999;
    assert.equal(cfg.get('gossip.ttl'), 3);
  });
});

describe('Config — advanced', () => {
  let cfg;
  beforeEach(() => { cfg = new Config(); });

  it('get() returns undefined for unknown key with no fallback', () => {
    assert.equal(cfg.get('no.such.key'), undefined);
  });

  it('set() + get() round-trips for string values', () => {
    cfg.set('signaling.heartbeatIntervalMs', 30000);
    assert.equal(cfg.get('signaling.heartbeatIntervalMs'), 30000);
  });

  it('merge() emits change event for each key', () => {
    const events = [];
    cfg.on('change', e => events.push(e.key));
    cfg.merge({ 'gossip.ttl': 3, 'gossip.fanout': 6 });
    assert.ok(events.includes('gossip.ttl'));
    assert.ok(events.includes('gossip.fanout'));
  });
});
