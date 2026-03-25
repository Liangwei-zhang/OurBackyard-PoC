import { EventBus } from '../event-bus.js';

export type SignalingStatus = 'online' | 'offline';

export interface RTCSignal {
  type: 'offer' | 'answer' | 'ice-candidate';
  [key: string]: unknown;
}

/**
 * ISignaling — abstract signaling interface.
 *
 * Events emitted:
 *   'signal'        (fromPeerId: string, signal: RTCSignal)
 *   'peer:announce' (peerId: string, meta: object)
 *   'status'        (status: SignalingStatus)
 */
export declare class ISignaling extends EventBus {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendSignal(targetPeerId: string, signal: RTCSignal): Promise<void>;
  announce(meta?: object): Promise<void>;
  readonly isOnline: boolean;
}
