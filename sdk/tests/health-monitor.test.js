import { HealthMonitor } from '../src/resilience/health-monitor.js';
import config from '../src/config.js';

describe('HealthMonitor', () => {
  beforeEach(() => config.reset());

  test('handlePing() replies with pong', () => {
    const sent = [];
    const hm = new HealthMonitor({ sendToPeer: (id, data) => { sent.push({ id, data }); return true; } });
    hm.addPeer('peer1');
    hm.handlePing('peer1', { type: 'health:ping', ts: 12345 });
    expect(sent).toHaveLength(1);
    const pong = JSON.parse(sent[0].data);
    expect(pong.type).toBe('health:pong');
    expect(pong.ts).toBe(12345);
  });

  test('handlePong() updates RTT', () => {
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.addPeer('p');
    const ts = Date.now() - 50; // simulate 50ms RTT
    hm.handlePong('p', { type: 'health:pong', ts });
    expect(hm.avgRtt('p')).toBeGreaterThan(0);
  });

  test('isHealthy() returns true for new peer', () => {
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.addPeer('p');
    expect(hm.isHealthy('p')).toBe(true);
  });

  test('isHealthy() returns false after unhealthyThreshold misses', () => {
    config.set('healthMonitor.unhealthyThreshold', 2);
    const hm = new HealthMonitor({ sendToPeer: () => false }); // always fails
    hm.addPeer('p');
    hm.start();
    // Manually simulate missed pings
    const h = hm._health.get('p');
    h.misses = 2;
    expect(hm.isHealthy('p')).toBe(false);
    hm.stop();
  });

  test('score() starts at 100', () => {
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.addPeer('p');
    expect(hm.score('p')).toBe(100);
  });

  test('removePeer() removes from tracking', () => {
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.addPeer('p');
    hm.removePeer('p');
    expect(hm.score('p')).toBe(0);
  });

  test('emits "rtt" event on pong', () => {
    const events = [];
    const hm = new HealthMonitor({ sendToPeer: () => true });
    hm.on('rtt', e => events.push(e));
    hm.addPeer('p');
    hm.handlePong('p', { type: 'health:pong', ts: Date.now() - 10 });
    expect(events).toHaveLength(1);
    expect(events[0].peerId).toBe('p');
  });
});
