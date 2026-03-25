import { EventBus } from '../event-bus.js';

/**
 * ReconnectManager — disconnection detection with exponential-backoff reconnect.
 *
 * Events emitted:
 *   'reconnecting' ({ peerId, attempt })
 *   'reconnected'  ({ peerId })
 *   'give-up'      ({ peerId, attempts })
 */
export declare class ReconnectManager extends EventBus {
  constructor(opts: {
    /** Async function called to re-establish a connection to a peer. */
    reconnect: (peerId: string) => Promise<void>;
  });

  onDisconnect(peerId: string): void;
  onConnect(peerId: string): void;
  pause(peerId: string): void;
  resume(peerId: string): void;
  reset(peerId: string): void;
}
