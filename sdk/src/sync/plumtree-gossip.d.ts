import { EventBus } from '../event-bus.js';

/**
 * PlumtreeGossip — Hybrid push/lazy-push epidemic broadcast.
 * Delivers messages to all peers while reducing redundant transmissions by ~40–60%.
 *
 * Events emitted:
 *   'message:received' ({ topic: string, payload: unknown, from: string, msgId: string })
 */
export declare class PlumtreeGossip extends EventBus {
  constructor(opts: {
    router: import('./message-router.js').MessageRouter;
    peerId: string;
    fanout?: number;
    /** Time-to-live hop limit (default: 5). */
    ttl?: number;
  });

  addPeer(peerId: string): void;
  removePeer(peerId: string): void;

  /**
   * Gossip a payload to the network.
   * @param topic  - Application-defined topic string (e.g. 'item', 'chat')
   * @param payload - Serialisable object
   * @returns Message ID
   */
  gossip(topic: string, payload: unknown): string;

  setSendFn(fn: (toPeerId: string, msg: object) => void): void;

  /** Number of peers in the eager (push) set. */
  readonly eagerPeerCount: number;
}
