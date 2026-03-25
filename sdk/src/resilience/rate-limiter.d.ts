import { EventBus } from '../event-bus.js';

/**
 * RateLimiter — token-bucket rate limiting per peer.
 *
 * Events emitted:
 *   'limited' ({ peerId, tokens, cost })
 */
export declare class RateLimiter extends EventBus {
  constructor(opts?: {
    /** Max tokens per peer bucket. Defaults to config value. */
    capacity?: number;
    /** Tokens added per second. Defaults to config value. */
    refillRate?: number;
  });

  /**
   * Consume `cost` tokens for a peer.
   * @returns true if allowed, false if rate-limited.
   */
  consume(peerId: string, cost?: number): boolean;

  /** Check token availability without consuming. */
  check(peerId: string, cost?: number): boolean;

  /** Current token count for a peer (after automatic refill). */
  tokens(peerId: string): number;

  /** Reset a peer's token bucket (e.g., after a reconnect grace period). */
  reset(peerId: string): void;
}
