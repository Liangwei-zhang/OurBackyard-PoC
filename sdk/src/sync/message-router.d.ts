import { EventBus } from '../event-bus.js';

export declare const Priority: {
  readonly HIGH: 0;
  readonly NORMAL: 1;
  readonly LOW: 2;
};

export type PriorityValue = 0 | 1 | 2;

export interface RouterMetrics {
  routed: number;
  invoked: number;
  errors: number;
  duplicates: number;
}

/**
 * MessageRouter — typed message routing with dedup, priority, and metrics.
 *
 * Events emitted:
 *   'route:error'     ({ type, fromPeerId, error })
 *   'route:unhandled' ({ type, fromPeerId, message })
 */
export declare class MessageRouter extends EventBus {
  metrics: RouterMetrics;

  constructor(opts?: { dedupCapacity?: number; handlerTimeoutMs?: number });

  /**
   * Register a handler for a message type (or '*' for all types).
   * @param type - Message type string or '*' wildcard
   * @param fn   - (fromPeerId: string, message: object) => void | Promise<void>
   */
  handle(type: string, fn: (fromPeerId: string, message: object) => void | Promise<void>, priority?: PriorityValue): this;

  /** Remove a previously registered handler. */
  unhandle(type: string, fn: Function): this;

  /**
   * Route a message from a peer through registered handlers.
   * Deduplicates by message.id.
   */
  route(fromPeerId: string, message: object & { type: string; id?: string }): Promise<void>;

  /** Return the number of registered handler types. */
  handlerCount(): number;
}
