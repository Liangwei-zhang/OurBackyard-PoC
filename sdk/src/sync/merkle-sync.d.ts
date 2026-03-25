import { EventBus } from '../event-bus.js';
import { IStorage } from '../storage/storage-interface.js';

/**
 * MerkleSync — Incremental state reconciliation via SHA-256 Merkle trees.
 *
 * Events emitted:
 *   'sync:completed' ({ peerId: string, delta: number })
 */
export declare class MerkleSync extends EventBus {
  constructor(opts: {
    router: import('./message-router.js').MessageRouter;
    storage: IStorage;
    peerId: string;
    syncIntervalMs?: number;
  });

  /** Trigger an immediate sync with all known peers. */
  syncAll(getPeers: () => string[]): Promise<void>;

  /** Start the periodic background sync loop. */
  startSync(getPeers: () => string[]): void;

  /** Stop the periodic background sync loop. */
  stopSync(): void;

  /** Compute the current Merkle root of local storage. */
  computeRoot(): Promise<string>;
}
