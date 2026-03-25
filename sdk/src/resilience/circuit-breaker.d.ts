import { EventBus } from '../event-bus.js';

export declare const BreakerState: {
  readonly CLOSED: 'CLOSED';
  readonly OPEN: 'OPEN';
  readonly HALF_OPEN: 'HALF_OPEN';
};

export type BreakerStateValue = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * CircuitBreaker — auto-block misbehaving peers.
 *
 * States: CLOSED (normal) → OPEN (blocked) → HALF_OPEN (probing) → CLOSED
 *
 * Events emitted:
 *   'opened'    ({ peerId })
 *   'closed'    ({ peerId })
 *   'half-open' ({ peerId })
 */
export declare class CircuitBreaker extends EventBus {
  constructor();

  /**
   * Returns true if the peer is permitted to interact.
   * Automatically transitions OPEN → HALF_OPEN after the configured timeout.
   */
  allow(peerId: string): boolean;

  recordSuccess(peerId: string): void;
  recordFailure(peerId: string, reason?: string): void;

  getState(peerId: string): BreakerStateValue;
  reset(peerId: string): void;
}
