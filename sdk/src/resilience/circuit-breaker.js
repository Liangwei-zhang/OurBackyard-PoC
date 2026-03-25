/**
 * @file circuit-breaker.js
 * @description Auto-disconnect misbehaving peers (spam, invalid messages, excessive reconnects).
 * States: CLOSED (normal) → OPEN (blocked) → HALF_OPEN (testing) → CLOSED
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('CircuitBreaker');

export const BreakerState = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

export class CircuitBreaker extends EventBus {
  constructor() {
    super();
    /** @type {Map<string, { state: string, failures: number, successes: number, openedAt: number|null }>} */
    this._breakers = new Map();
  }

  /**
   * Check whether a peer is currently allowed through.
   * Automatically transitions OPEN → HALF_OPEN after timeout.
   * @param {string} peerId
   * @returns {boolean} true = allow, false = block
   */
  allow(peerId) {
    const b = this._getOrCreate(peerId);
    if (b.state === BreakerState.CLOSED) return true;

    if (b.state === BreakerState.OPEN) {
      const halfOpenTimeout = config.get('circuitBreaker.halfOpenTimeout');
      if (Date.now() - b.openedAt >= halfOpenTimeout) {
        b.state = BreakerState.HALF_OPEN;
        b.successes = 0;
        log.info(`Circuit HALF_OPEN for ${peerId}`);
        this.emit('half-open', { peerId });
        return true; // Allow one test message through
      }
      return false;
    }

    // HALF_OPEN: allow
    return true;
  }

  /**
   * Record a successful interaction with a peer.
   * @param {string} peerId
   */
  recordSuccess(peerId) {
    const b = this._getOrCreate(peerId);
    if (b.state === BreakerState.HALF_OPEN) {
      b.successes++;
      const threshold = config.get('circuitBreaker.successThreshold');
      if (b.successes >= threshold) {
        b.state = BreakerState.CLOSED;
        b.failures = 0;
        b.openedAt = null;
        log.info(`Circuit CLOSED for ${peerId}`);
        this.emit('closed', { peerId });
      }
    } else if (b.state === BreakerState.CLOSED) {
      // Decay failures on success
      b.failures = Math.max(0, b.failures - 1);
    }
  }

  /**
   * Record a failure or misbehavior from a peer.
   * @param {string} peerId
   * @param {string} [reason]
   */
  recordFailure(peerId, reason = 'unknown') {
    const b = this._getOrCreate(peerId);
    b.failures++;
    log.warn(`Failure recorded for ${peerId} (reason: ${reason}, total: ${b.failures})`);

    const threshold = config.get('circuitBreaker.failureThreshold');
    if (b.failures >= threshold && b.state === BreakerState.CLOSED) {
      b.state = BreakerState.OPEN;
      b.openedAt = Date.now();
      log.warn(`Circuit OPEN for ${peerId}`);
      this.emit('open', { peerId, reason });
    } else if (b.state === BreakerState.HALF_OPEN) {
      // Failed during probe — re-open
      b.state = BreakerState.OPEN;
      b.openedAt = Date.now();
      b.successes = 0;
      this.emit('open', { peerId, reason: 'half-open probe failed' });
    }
  }

  /**
   * Get the current state of a peer's circuit breaker.
   * @param {string} peerId
   * @returns {string} BreakerState value
   */
  getState(peerId) {
    return this._getOrCreate(peerId).state;
  }

  /**
   * Manually reset a peer's circuit breaker.
   * @param {string} peerId
   */
  reset(peerId) {
    this._breakers.delete(peerId);
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /** @private */
  _getOrCreate(peerId) {
    if (!this._breakers.has(peerId)) {
      this._breakers.set(peerId, { state: BreakerState.CLOSED, failures: 0, successes: 0, openedAt: null });
    }
    return this._breakers.get(peerId);
  }
}

export default CircuitBreaker;
