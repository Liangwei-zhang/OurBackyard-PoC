import { CircuitBreaker, BreakerState } from '../src/resilience/circuit-breaker.js';
import config from '../src/config.js';

describe('CircuitBreaker', () => {
  let cb;
  beforeEach(() => {
    config.reset();
    cb = new CircuitBreaker();
  });

  test('starts CLOSED — allow() returns true', () => {
    expect(cb.allow('peer1')).toBe(true);
    expect(cb.getState('peer1')).toBe(BreakerState.CLOSED);
  });

  test('opens after failureThreshold failures', () => {
    config.set('circuitBreaker.failureThreshold', 3);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    cb.recordFailure('p');
    cb.recordFailure('p');
    expect(cb.getState('p')).toBe(BreakerState.OPEN);
    expect(cb.allow('p')).toBe(false);
  });

  test('emits "open" event when tripping', () => {
    config.set('circuitBreaker.failureThreshold', 2);
    cb = new CircuitBreaker();
    const events = [];
    cb.on('open', e => events.push(e));
    cb.recordFailure('p');
    cb.recordFailure('p');
    expect(events).toHaveLength(1);
    expect(events[0].peerId).toBe('p');
  });

  test('transitions to HALF_OPEN after halfOpenTimeout', async () => {
    config.set('circuitBreaker.failureThreshold', 1);
    config.set('circuitBreaker.halfOpenTimeout', 50);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    expect(cb.getState('p')).toBe(BreakerState.OPEN);
    await new Promise(r => setTimeout(r, 60));
    expect(cb.allow('p')).toBe(true); // triggers HALF_OPEN
    expect(cb.getState('p')).toBe(BreakerState.HALF_OPEN);
  });

  test('HALF_OPEN → CLOSED after successThreshold successes', async () => {
    config.set('circuitBreaker.failureThreshold', 1);
    config.set('circuitBreaker.halfOpenTimeout', 10);
    config.set('circuitBreaker.successThreshold', 2);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    await new Promise(r => setTimeout(r, 20));
    cb.allow('p'); // → HALF_OPEN
    cb.recordSuccess('p');
    cb.recordSuccess('p');
    expect(cb.getState('p')).toBe(BreakerState.CLOSED);
  });

  test('HALF_OPEN → OPEN again on failure', async () => {
    config.set('circuitBreaker.failureThreshold', 1);
    config.set('circuitBreaker.halfOpenTimeout', 10);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    await new Promise(r => setTimeout(r, 20));
    cb.allow('p'); // → HALF_OPEN
    cb.recordFailure('p', 'probe-failed');
    expect(cb.getState('p')).toBe(BreakerState.OPEN);
  });

  test('reset() restores CLOSED state', () => {
    config.set('circuitBreaker.failureThreshold', 1);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    cb.reset('p');
    expect(cb.getState('p')).toBe(BreakerState.CLOSED);
    expect(cb.allow('p')).toBe(true);
  });

  test('recordSuccess() decays failures in CLOSED state', () => {
    config.set('circuitBreaker.failureThreshold', 3);
    cb = new CircuitBreaker();
    cb.recordFailure('p');
    cb.recordFailure('p');
    cb.recordSuccess('p'); // should decay back to 1
    cb.recordFailure('p'); // now at 2
    expect(cb.getState('p')).toBe(BreakerState.CLOSED); // not tripped yet
  });
});
