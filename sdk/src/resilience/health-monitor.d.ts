import { EventBus } from '../event-bus.js';

export interface PeerHealthRecord {
  rtt: number[];
  lastPing: number | null;
  misses: number;
  score: number;
}

/**
 * HealthMonitor — per-peer RTT scoring via periodic ping/pong.
 *
 * Events emitted:
 *   'peer:healthy'   ({ peerId, score })
 *   'peer:unhealthy' ({ peerId, score })
 */
export declare class HealthMonitor extends EventBus {
  constructor(opts: {
    sendToPeer: (peerId: string, msg: string) => boolean;
  });

  start(): void;
  stop(): void;

  addPeer(peerId: string): void;
  removePeer(peerId: string): void;

  /** Handle an incoming PONG message. */
  handlePong(peerId: string, pingId: string): void;

  getHealth(peerId: string): PeerHealthRecord | undefined;
}
