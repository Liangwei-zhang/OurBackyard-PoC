/**
 * Tests for RateLimiter — token bucket rate limiting.
 * Run with: node --test sdk/tests/rate-limiter.test.js
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { RateLimiter } from '../src/resilience/rate-limiter.js';

describe('RateLimiter', () => {
  it('consume() returns true when tokens available', () => {
    const rl = new RateLimiter({ capacity: 10, refillRate: 1 });
    assert.equal(rl.consume('peer1'), true);
  });

  it('consume() returns false when bucket exhausted', () => {
    const rl = new RateLimiter({ capacity: 2, refillRate: 0 });
    rl.consume('peer1');
    rl.consume('peer1');
    assert.equal(rl.consume('peer1'), false);
  });

  it('tokens() reflects remaining tokens', () => {
    const rl = new RateLimiter({ capacity: 5, refillRate: 0 });
    rl.consume('p', 2);
    assert.ok(Math.abs(rl.tokens('p') - 3) < 0.5);
  });

  it('check() does not consume tokens', () => {
    const rl = new RateLimiter({ capacity: 5, refillRate: 0 });
    assert.equal(rl.check('p', 5), true);
    assert.ok(Math.abs(rl.tokens('p') - 5) < 0.5);
  });

  it('reset() restores full capacity', () => {
    const rl = new RateLimiter({ capacity: 3, refillRate: 0 });
    rl.consume('p'); rl.consume('p'); rl.consume('p');
    assert.equal(rl.consume('p'), false);
    rl.reset('p');
    assert.equal(rl.consume('p'), true);
  });

  it('emits "limited" event when blocked', () => {
    const events = [];
    const rl = new RateLimiter({ capacity: 1, refillRate: 0 });
    rl.on('limited', e => events.push(e));
    rl.consume('p');
    rl.consume('p');
    assert.equal(events.length, 1);
    assert.equal(events[0].peerId, 'p');
  });

  it('different peers have independent buckets', () => {
    const rl = new RateLimiter({ capacity: 1, refillRate: 0 });
    rl.consume('alice');
    assert.equal(rl.consume('alice'), false);
    assert.equal(rl.consume('bob'), true);
  });

  it('cost > 1 consumes multiple tokens', () => {
    const rl = new RateLimiter({ capacity: 10, refillRate: 0 });
    rl.consume('p', 8);
    assert.equal(rl.check('p', 3), false);
    assert.equal(rl.check('p', 2), true);
  });
});
