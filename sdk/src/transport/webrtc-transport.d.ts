import { ITransport } from './transport-interface.js';

export interface ICEServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * WebRTCTransport — RTCPeerConnection-backed ITransport.
 * Handles offer/answer/ICE exchange, glare resolution, and backpressure.
 */
export declare class WebRTCTransport extends ITransport {
  constructor(opts: {
    peerId: string;
    iceServers?: ICEServer[];
  });

  connect(peerId: string, signalingChannel: object): Promise<void>;
  send(peerId: string, data: string | ArrayBuffer): boolean;
  broadcast(data: string | ArrayBuffer, excludePeerId?: string): void;
  disconnect(peerId: string): void;
  close(): void;

  /** Number of currently open data channels. */
  readonly connectionCount: number;

  /** Whether a data channel to this peer is open. */
  isConnected(peerId: string): boolean;

  /** Destroy all open peer connections. */
  destroyAll(): void;
}
