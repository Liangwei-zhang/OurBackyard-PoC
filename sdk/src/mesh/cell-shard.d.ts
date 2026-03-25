import { EventBus } from '../event-bus.js';

export interface PeerInfo {
  peerId: string;
  cell: string;
  l7: string;
  connectedAt: number;
  lastSeen: number;
}

/**
 * CellShard — Geographic peer management via H3 hexagonal cells.
 *
 * Events emitted:
 *   'cell:joined'  ({ peerId, cell, l7 })
 *   'cell:left'    ({ peerId, cell })
 *   'cell:split'   ({ cell, peerCount })
 *   'peers:updated' ({ peers: PeerInfo[] })
 */
export declare class CellShard extends EventBus {
  constructor(opts: {
    peerId: string;
    h3Cell: string;
    maxPeersPerCell?: number;
    adjacentCellDepth?: number;
    hotThreshold?: number;
  });

  /** Add or update a peer with its H3 L9 cell. */
  addPeer(peerId: string, h3Cell: string): void;

  /** Remove a peer from all cell tracking. */
  removePeer(peerId: string): void;

  /** All tracked peers. */
  getAllPeers(): PeerInfo[];

  /** Peers in the same L9 cell or adjacent cells. */
  getNearbyPeers(): PeerInfo[];

  /** Peers in the same L7 parent cell. */
  getCellPeers(h3Cell: string): PeerInfo[];

  /** Whether the local cell is considered "hot" (above threshold). */
  isHot(): boolean;

  /** Compute the L7 parent cell for a given L9 cell. */
  getL7(h3Cell: string): string;
}
