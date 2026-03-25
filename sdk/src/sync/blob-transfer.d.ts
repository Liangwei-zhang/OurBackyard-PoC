import { EventBus } from '../event-bus.js';

export declare const BlobPriority: {
  readonly PROFILE: 0;
  readonly LISTING: 1;
  readonly OTHER: 2;
};

export type BlobPriorityValue = 0 | 1 | 2;

export interface BlobMeta {
  name?: string;
  mimeType?: string;
  size?: number;
  priority?: BlobPriorityValue;
  [key: string]: unknown;
}

/**
 * BlobTransfer — chunked binary blob streaming over P2P DataChannels.
 *
 * Events emitted:
 *   'transfer:start'    ({ transferId, fromPeerId, meta })
 *   'transfer:progress' ({ transferId, received, total })
 *   'transfer:complete' ({ transferId, data: ArrayBuffer, meta })
 *   'transfer:error'    ({ transferId, error })
 */
export declare class BlobTransfer extends EventBus {
  constructor(opts: {
    router: import('./message-router.js').MessageRouter;
    peerId: string;
    chunkSize?: number;
    maxConcurrent?: number;
    maxRetries?: number;
  });

  /**
   * Send a blob to a peer.
   * @returns Transfer ID
   */
  send(
    toPeerId: string,
    data: ArrayBuffer | Uint8Array,
    meta?: BlobMeta
  ): Promise<string>;

  /** Cancel an in-progress outbound transfer. */
  cancel(transferId: string): void;

  /** Number of currently active (in-flight) outbound transfers. */
  readonly activeCount: number;
}
