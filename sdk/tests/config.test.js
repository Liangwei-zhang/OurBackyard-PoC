import { Config } from '../src/config.js';

describe('Config', () => {
  let cfg;
  beforeEach(() => { cfg = new Config(); });

  test('get() returns default values', () => {
    expect(cfg.get('router.dedupCapacity')).toBe(50000);
    expect(cfg.get('transport.reconnectMaxAttempts')).toBe(10);
  });

  test('get() returns fallback for unknown keys', () => {
    expect(cfg.get('no.such.key', 42)).toBe(42);
  });

  test('set() updates value', () => {
    cfg.set('gossip.ttl', 10);
    expect(cfg.get('gossip.ttl')).toBe(10);
  });

  test('set() emits "change" event', () => {
    const events = [];
    cfg.on('change', e => events.push(e));
    cfg.set('gossip.ttl', 7);
    expect(events[0]).toMatchObject({ key: 'gossip.ttl', newValue: 7 });
  });

  test('set() throws RangeError for invalid value (validator)', () => {
    expect(() => cfg.set('router.dedupCapacity', -1)).toThrow(RangeError);
    expect(() => cfg.set('router.dedupCapacity', 2)).toThrow(RangeError);
  });

  test('merge() applies multiple overrides', () => {
    cfg.merge({ 'gossip.ttl': 8, 'gossip.fanout': 5 });
    expect(cfg.get('gossip.ttl')).toBe(8);
    expect(cfg.get('gossip.fanout')).toBe(5);
  });

  test('reset() restores defaults', () => {
    cfg.set('gossip.ttl', 99);
    cfg.reset();
    expect(cfg.get('gossip.ttl')).toBe(5);
  });

  test('reset() emits "reset" event', () => {
    const events = [];
    cfg.on('reset', e => events.push(e));
    cfg.reset();
    expect(events).toHaveLength(1);
  });

  test('snapshot() returns a copy of current config', () => {
    cfg.set('gossip.ttl', 3);
    const snap = cfg.snapshot();
    expect(snap['gossip.ttl']).toBe(3);
    // Mutating snapshot does not affect config
    snap['gossip.ttl'] = 999;
    expect(cfg.get('gossip.ttl')).toBe(3);
  });
});
