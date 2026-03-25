import { ISignaling, RTCSignal } from './signaling-interface.js';

/** WebSocket-based centralized signaling (fallback). */
export declare class WebSocketSignaling extends ISignaling {
  constructor(opts: { peerId: string; url: string });

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendSignal(targetPeerId: string, signal: RTCSignal): Promise<void>;
  announce(meta?: object): Promise<void>;
  readonly isOnline: boolean;
}
