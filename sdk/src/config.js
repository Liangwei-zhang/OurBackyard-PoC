/**
 * @file config.js
 * @description Global configuration registry with defaults, validation, and runtime override support.
 * Zero external dependencies.
 */

import { EventBus } from './event-bus.js';

/** @type {Record<string, *>} */
const DEFAULTS = {
  // Transport
  'transport.maxBufferBytes': 16 * 1024 * 1024, // 16 MB backpressure threshold
  'transport.iceRestartDelay': 2000,
  'transport.reconnectMaxAttempts': 10,
  'transport.reconnectBaseDelay': 1000,
  'transport.reconnectMaxDelay': 30000,

  // Signaling
  'signaling.announceIntervalMs': 30000,
  'signaling.heartbeatIntervalMs': 20000,

  // Routing
  'router.dedupCapacity': 50000,
  'router.maxMessageBytes': 1024 * 1024, // 1 MB per message

  // Gossip
  'gossip.ttl': 5,
  'gossip.fanout': 3,

  // Rate Limiting
  'rateLimiter.defaultCapacity': 100,
  'rateLimiter.defaultRefillRate': 10, // tokens/sec

  // Circuit Breaker
  'circuitBreaker.failureThreshold': 5,
  'circuitBreaker.successThreshold': 2,
  'circuitBreaker.halfOpenTimeout': 10000,

  // Health Monitor
  'healthMonitor.pingIntervalMs': 5000,
  'healthMonitor.pingTimeoutMs': 3000,
  'healthMonitor.unhealthyThreshold': 3,

  // Identity
  'identity.storageKey': 'ob_identity_v1',
};

/** @type {Map<string, (v: *) => boolean>} validators keyed by config key prefix */
const VALIDATORS = new Map([
  ['transport.maxBufferBytes', v => typeof v === 'number' && v > 0],
  ['transport.reconnectMaxAttempts', v => Number.isInteger(v) && v >= 0],
  ['router.dedupCapacity', v => Number.isInteger(v) && v >= 100],
  ['router.maxMessageBytes', v => typeof v === 'number' && v > 0],
  ['rateLimiter.defaultCapacity', v => typeof v === 'number' && v > 0],
  ['rateLimiter.defaultRefillRate', v => typeof v === 'number' && v > 0],
]);

export class Config extends EventBus {
  constructor() {
    super();
    this._store = { ...DEFAULTS };
  }

  /**
   * Get a configuration value.
   * @param {string} key
   * @param {*} [fallback]
   * @returns {*}
   */
  get(key, fallback = undefined) {
    return key in this._store ? this._store[key] : fallback;
  }

  /**
   * Set a configuration value, running validators if defined.
   * Emits 'change' with { key, oldValue, newValue }.
   * @param {string} key
   * @param {*} value
   * @throws {RangeError} if value fails validation
   */
  set(key, value) {
    const validate = VALIDATORS.get(key);
    if (validate && !validate(value)) {
      throw new RangeError(`Invalid value for config key "${key}": ${JSON.stringify(value)}`);
    }
    const oldValue = this._store[key];
    this._store[key] = value;
    this.emit('change', { key, oldValue, newValue: value });
  }

  /**
   * Merge an object of key/value pairs. Useful for bulk initialization.
   * @param {Record<string, *>} overrides
   */
  merge(overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      this.set(k, v);
    }
  }

  /**
   * Reset all values to defaults.
   */
  reset() {
    this._store = { ...DEFAULTS };
    this.emit('reset', {});
  }

  /**
   * Return a snapshot of the current configuration.
   * @returns {Record<string, *>}
   */
  snapshot() {
    return { ...this._store };
  }
}

/** Singleton config instance */
export const config = new Config();

export default config;
