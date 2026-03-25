import { RateLimiter } from '../src/resilience/rate-limiter.js';
import config from '../src/config.js';

describe('RateLimiter', () => {
  beforeEach(() => config.reset());

  test('consume() returns true when tokens available', () => {
    const rl = new RateLimiter({ capacity: 10, refillRate: 1 });
    expect(rl.consume('peer1')).toBe(true);
  });

  test('consume() returns false when bucket exhausted', () => {
    const rl = new RateLimiter({ capacity: 2, refillRate: 0 });
    rl.consume('peer1');
    rl.consume('peer1');
    expect(rl.consume('peer1')).toBe(false);
  });

  test('tokens() reflects remaining tokens', () => {
    const rl = new RateLimiter({ capacity: 5, refillRate: 0 });
    rl.consume('p', 2);
    expect(rl.tokens('p')).toBeCloseTo(3, 0);
  });

  test('check() does not consume tokens', () => {
    const rl = new RateLimiter({ capacity: 5, refillRate: 0 });
    expect(rl.check('p', 5)).toBe(true);
    expect(rl.tokens('p')).toBeCloseTo(5, 0);
  });

  test('reset() restores full capacity', () => {
    const rl = new RateLimiter({ capacity: 3, refillRate: 0 });
    rl.consume('p'); rl.consume('p'); rl.consume('p');
    expect(rl.consume('p')).toBe(false);
    rl.reset('p');
    expect(rl.consume('p')).toBe(true);
  });

  test('emits "limited" event when blocked', () => {
    const events = [];
    const rl = new RateLimiter({ capacity: 1, refillRate: 0 });
    rl.on('limited', e => events.push(e));
    rl.consume('p');
    rl.consume('p'); // triggers limited
    expect(events).toHaveLength(1);
    expect(events[0].peerId).toBe('p');
  });

  test('different peers have independent buckets', () => {
    const rl = new RateLimiter({ capacity: 1, refillRate: 0 });
    rl.consume('alice');
    expect(rl.consume('alice')).toBe(false);
    expect(rl.consume('bob')).toBe(true);
  });

  test('cost > 1 consumes multiple tokens', () => {
    const rl = new RateLimiter({ capacity: 10, refillRate: 0 });
    rl.consume('p', 8);
    expect(rl.check('p', 3)).toBe(false);
    expect(rl.check('p', 2)).toBe(true);
  });
});
