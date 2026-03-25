import { EventBus } from '../event-bus.js';

/**
 * ITransport — abstract transport interface.
 *
 * Events emitted:
 *   'open'    ({ peerId: string })
 *   'message' ({ peerId: string, data: string | ArrayBuffer })
 *   'close'   ({ peerId: string, reason?: string })
 *   'error'   ({ peerId: string, error: Error })
 */
export declare class ITransport extends EventBus {
  connect(peerId: string, signalingChannel: object): Promise<void>;
  send(peerId: string, data: string | ArrayBuffer): boolean;
  broadcast(data: string | ArrayBuffer, excludePeerId?: string): void;
  disconnect(peerId: string): void;
  close(): void;
}
