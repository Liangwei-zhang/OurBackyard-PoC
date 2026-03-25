import { ISignaling, RTCSignal } from './signaling-interface.js';

/**
 * MultiSignaling — Priority-ordered failover across multiple signaling backends.
 * Default priority: Nostr → WebSocket → LAN.
 */
export declare class MultiSignaling extends ISignaling {
  constructor(opts: {
    peerId: string;
    h3Cell: string;
    signalings?: ISignaling[];
  });

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendSignal(targetPeerId: string, signal: RTCSignal): Promise<void>;
  announce(meta?: object): Promise<void>;
  readonly isOnline: boolean;

  /** Index of the currently active signaling backend. */
  readonly activeIndex: number;
}
