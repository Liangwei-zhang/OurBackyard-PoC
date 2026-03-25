/**
 * Tests for HealthMonitor — per-peer RTT health scoring.
 * Run with: node --test sdk/tests/health-monitor.test.js
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { HealthMonitor } from '../src/resilience/health-monitor.js';
import config from '../src/config.js';

describe('HealthMonitor', () => {
  beforeEach(() => { config.reset(); });

  it('handlePing() replies with pong', () => {
    const sent = [];
    const hm = new HealthMonitor({ sendToPeer: (id, data) => { sent.push({ id, data }); return true; } });
    hm.addPeer('peer1');
    hm.handlePing('peer1', { type: 'health:ping', ts: 12345 });
    assert.equal(sent.length, 1);
    const pong = JSON.parse(sent[0].data);
    assert.equal(pong.type, 'health:pong');
    assert.equal(pong.ts, 12345);
  });

  it('handlePong() updates RTT', () => {
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.addPeer('p');
    const ts = Date.now() - 50;
    hm.handlePong('p', { type: 'health:pong', ts });
    assert.ok(hm.avgRtt('p') > 0);
  });

  it('isHealthy() returns true for new peer', () => {
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.addPeer('p');
    assert.equal(hm.isHealthy('p'), true);
  });

  it('isHealthy() returns false after unhealthyThreshold misses', () => {
    config.set('healthMonitor.unhealthyThreshold', 2);
    const hm = new HealthMonitor({ sendToPeer: () => false });
    hm.addPeer('p');
    hm.start();
    const h = hm._health.get('p');
    h.misses = 2;
    assert.equal(hm.isHealthy('p'), false);
    hm.stop();
  });

  it('score() starts at 100', () => {
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.addPeer('p');
    assert.equal(hm.score('p'), 100);
  });

  it('removePeer() removes from tracking', () => {
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.addPeer('p');
    hm.removePeer('p');
    assert.equal(hm.score('p'), 0);
  });

  it('emits "rtt" event on pong', () => {
    const events = [];
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.on('rtt', e => events.push(e));
    hm.addPeer('p');
    hm.handlePong('p', { type: 'health:pong', ts: Date.now() - 10 });
    assert.equal(events.length, 1);
    assert.equal(events[0].peerId, 'p');
  });
});
