import { EventBus } from '../event-bus.js';
import { IStorage } from '../storage/storage-interface.js';

export interface MarketplaceItem {
  id: string;
  title: string;
  price?: number;
  description?: string;
  category?: string;
  sellerId: string;
  status: 'available' | 'reserved' | 'sold';
  createdAt: number;
  updatedAt: number;
  h3Cell: string;
  [key: string]: unknown;
}

/**
 * GossipSync — high-level P2P data synchronization.
 *
 * Combines PlumtreeGossip + MerkleSync + CRDT for marketplace item sync.
 *
 * Events emitted:
 *   'item:received' ({ topic, payload, from, msgId })
 *   'item:updated'  ({ id, status })
 *   'sync:completed' ({ peerId, delta })
 *   'peer:added'    ({ peerId })
 *   'peer:removed'  ({ peerId })
 */
export declare class GossipSync extends EventBus {
  constructor(opts: {
    router: import('./message-router.js').MessageRouter;
    storage: IStorage;
    peerId: string;
    fanout?: number;
    syncIntervalMs?: number;
    ttl?: number;
  });

  addPeer(peerId: string): void;
  removePeer(peerId: string): void;

  /** Publish a marketplace item and gossip it to the network. */
  publishItem(item: MarketplaceItem): Promise<string>;

  /** Update an item's status via LWW merge. */
  updateItemStatus(itemId: string, status: string): Promise<void>;

  /** Toggle a favorite for the current user via ORSet. */
  toggleFavorite(userId: string, itemId: string, add: boolean): Promise<void>;

  /** Increment the view counter for an item via GCounter. */
  incrementView(itemId: string): Promise<void>;

  /** Wire the send function for outbound gossip messages. */
  setSendFn(fn: (toPeerId: string, msg: object) => void): void;

  /** Start the periodic Merkle sync loop. */
  startSync(getPeers: () => string[]): void;

  /** Stop the periodic Merkle sync loop. */
  stopSync(): void;
}
