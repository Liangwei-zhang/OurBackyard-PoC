import { EventBus } from '../event-bus.js';

export declare const Quality: {
  readonly EXCELLENT: 4;
  readonly GOOD: 3;
  readonly FAIR: 2;
  readonly POOR: 1;
  readonly DEAD: 0;
};

export type QualityValue = 0 | 1 | 2 | 3 | 4;

export interface PeerHealth {
  lastPing: number;
  lastPong: number;
  rtt: number;
  reconnectAttempts: number;
  quality: QualityValue;
  totalPings: number;
  totalPongs: number;
  circuitOpen: boolean;
}

/**
 * ResilienceManager — heartbeat, RTT tracking, reconnect, circuit-breaker.
 *
 * Events emitted:
 *   'peer:healthy'     ({ peerId, quality })
 *   'peer:degraded'    ({ peerId, quality })
 *   'peer:dead'        ({ peerId })
 *   'peer:reconnected' ({ peerId })
 *   'health:report'    (Map<string, PeerHealth>)
 */
export declare class ResilienceManager extends EventBus {
  constructor(opts: {
    router: import('../sync/message-router.js').MessageRouter;
    transport: import('../transport/webrtc-transport.js').WebRTCTransport;
    heartbeatIntervalMs?: number;
    maxReconnectAttempts?: number;
    reconnectBaseMs?: number;
    pongTimeoutMs?: number;
  });

  setSendFn(fn: (toPeerId: string, msg: object) => void): void;

  startMonitoring(): void;
  stopMonitoring(): void;

  addPeer(peerId: string): void;
  removePeer(peerId: string): void;

  getPeerHealth(peerId: string): PeerHealth | null;
  getAllHealth(): Map<string, PeerHealth>;
  getQuality(peerId: string): QualityValue;
}
