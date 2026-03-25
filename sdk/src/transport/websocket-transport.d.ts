import { ITransport } from './transport-interface.js';

/**
 * WebSocketTransport — WebSocket-backed ITransport for server-relayed fallback.
 */
export declare class WebSocketTransport extends ITransport {
  constructor(opts: { url: string; peerId: string });

  connect(peerId: string, signalingChannel: object): Promise<void>;
  send(peerId: string, data: string | ArrayBuffer): boolean;
  broadcast(data: string | ArrayBuffer, excludePeerId?: string): void;
  disconnect(peerId: string): void;
  close(): void;
}
