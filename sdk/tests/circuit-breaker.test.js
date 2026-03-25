/**
 * Tests for CircuitBreaker — auto-block misbehaving peers.
 * Run with: node --test sdk/tests/circuit-breaker.test.js
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { CircuitBreaker, BreakerState } from '../src/resilience/circuit-breaker.js';
import config from '../src/config.js';

describe('CircuitBreaker', () => {
  let cb;
  beforeEach(() => {
    config.reset();
    cb = new CircuitBreaker();
  });

  it('starts CLOSED — allow() returns true', () => {
    assert.equal(cb.allow('peer1'), true);
    assert.equal(cb.getState('peer1'), BreakerState.CLOSED);
  });

  it('opens after failureThreshold failures', () => {
    config.set('circuitBreaker.failureThreshold', 3);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    cb.recordFailure('p');
    cb.recordFailure('p');
    assert.equal(cb.getState('p'), BreakerState.OPEN);
    assert.equal(cb.allow('p'), false);
  });

  it('emits "open" event when tripping', () => {
    config.set('circuitBreaker.failureThreshold', 2);
    cb = new CircuitBreaker();
    const events = [];
    cb.on('open', e => events.push(e));
    cb.recordFailure('p');
    cb.recordFailure('p');
    assert.equal(events.length, 1);
    assert.equal(events[0].peerId, 'p');
  });

  it('transitions to HALF_OPEN after halfOpenTimeout', async () => {
    config.set('circuitBreaker.failureThreshold', 1);
    config.set('circuitBreaker.halfOpenTimeout', 50);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    assert.equal(cb.getState('p'), BreakerState.OPEN);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(cb.allow('p'), true);
    assert.equal(cb.getState('p'), BreakerState.HALF_OPEN);
  });

  it('HALF_OPEN → CLOSED after successThreshold successes', async () => {
    config.set('circuitBreaker.failureThreshold', 1);
    config.set('circuitBreaker.halfOpenTimeout', 10);
    config.set('circuitBreaker.successThreshold', 2);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    await new Promise(r => setTimeout(r, 20));
    cb.allow('p');
    cb.recordSuccess('p');
    cb.recordSuccess('p');
    assert.equal(cb.getState('p'), BreakerState.CLOSED);
  });

  it('HALF_OPEN → OPEN again on failure', async () => {
    config.set('circuitBreaker.failureThreshold', 1);
    config.set('circuitBreaker.halfOpenTimeout', 10);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    await new Promise(r => setTimeout(r, 20));
    cb.allow('p');
    cb.recordFailure('p', 'probe-failed');
    assert.equal(cb.getState('p'), BreakerState.OPEN);
  });

  it('reset() restores CLOSED state', () => {
    config.set('circuitBreaker.failureThreshold', 1);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    cb.reset('p');
    assert.equal(cb.getState('p'), BreakerState.CLOSED);
    assert.equal(cb.allow('p'), true);
  });
});

describe('CircuitBreaker — advanced', () => {
  beforeEach(() => { config.reset(); });

  it('independent state per peer', () => {
    config.set('circuitBreaker.failureThreshold', 1);
    const cb = new CircuitBreaker();
    cb.recordFailure('alice');
    assert.equal(cb.allow('alice'), false);
    assert.equal(cb.allow('bob'), true);
  });

  it('multiple circuit breakers are independent', () => {
    config.set('circuitBreaker.failureThreshold', 1);
    const cb1 = new CircuitBreaker();
    const cb2 = new CircuitBreaker();
    cb1.recordFailure('p');
    assert.equal(cb1.allow('p'), false);
    assert.equal(cb2.allow('p'), true);
  });

  it('getState() returns CLOSED for unknown peer', () => {
    const cb = new CircuitBreaker();
    assert.equal(cb.getState('unknown'), BreakerState.CLOSED);
  });
});
