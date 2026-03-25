/**
 * @file rate-limiter.js
 * @description Token bucket rate limiting per peer (anti-DDoS/spam).
 * Each peer gets its own bucket. Tokens refill at a configurable rate.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('RateLimiter');

/** @typedef {{ tokens: number, lastRefill: number }} Bucket */

export class RateLimiter extends EventBus {
  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity]   — max tokens per peer (default: config)
   * @param {number} [opts.refillRate] — tokens added per second (default: config)
   */
  constructor(opts = {}) {
    super();
    this._capacity = opts.capacity ?? null;
    this._refillRate = opts.refillRate ?? null;
    /** @type {Map<string, Bucket>} */
    this._buckets = new Map();
  }

  /**
   * Consume one token for the given peer.
   * Returns true if allowed, false if rate limited.
   * @param {string} peerId
   * @param {number} [cost=1] — number of tokens to consume
   * @returns {boolean}
   */
  consume(peerId, cost = 1) {
    const bucket = this._getOrCreate(peerId);
    this._refill(bucket);
    if (bucket.tokens < cost) {
      log.warn(`Rate limit hit for ${peerId} (tokens=${bucket.tokens.toFixed(1)}, cost=${cost})`);
      this.emit('limited', { peerId, tokens: bucket.tokens, cost });
      return false;
    }
    bucket.tokens -= cost;
    return true;
  }

  /**
   * Check if a peer has enough tokens without consuming any.
   * @param {string} peerId
   * @param {number} [cost=1]
   * @returns {boolean}
   */
  check(peerId, cost = 1) {
    const bucket = this._getOrCreate(peerId);
    this._refill(bucket);
    return bucket.tokens >= cost;
  }

  /**
   * Reset a peer's token bucket (e.g., after a reconnect grace period).
   * @param {string} peerId
   */
  reset(peerId) {
    this._buckets.delete(peerId);
  }

  /**
   * Return the current token count for a peer (after refill calculation).
   * @param {string} peerId
   * @returns {number}
   */
  tokens(peerId) {
    const bucket = this._getOrCreate(peerId);
    this._refill(bucket);
    return bucket.tokens;
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /** @private */
  _getOrCreate(peerId) {
    if (!this._buckets.has(peerId)) {
      const capacity = this._capacity ?? config.get('rateLimiter.defaultCapacity');
      this._buckets.set(peerId, { tokens: capacity, lastRefill: Date.now() });
    }
    return this._buckets.get(peerId);
  }

  /** @private */
  _refill(bucket) {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000; // seconds
    const rate = this._refillRate ?? config.get('rateLimiter.defaultRefillRate');
    const capacity = this._capacity ?? config.get('rateLimiter.defaultCapacity');
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * rate);
    bucket.lastRefill = now;
  }
}

export default RateLimiter;
