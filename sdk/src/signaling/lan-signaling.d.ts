import { ISignaling, RTCSignal } from './signaling-interface.js';

/**
 * LanSignaling — BroadcastChannel-based peer discovery for same-device/same-LAN peers.
 */
export declare class LanSignaling extends ISignaling {
  constructor(opts: { peerId: string; h3Cell: string });

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendSignal(targetPeerId: string, signal: RTCSignal): Promise<void>;
  announce(meta?: object): Promise<void>;
  readonly isOnline: boolean;
}
