import { EventBus } from './event-bus.js';
import { IStorage } from './storage/storage-interface.js';
import { WebRTCTransport, ICEServer } from './transport/webrtc-transport.js';
import { ISignaling } from './signaling/signaling-interface.js';
import { MessageRouter } from './sync/message-router.js';
import { GossipSync } from './sync/gossip-sync.js';
import { BlobTransfer } from './sync/blob-transfer.js';
import { CellShard, PeerInfo } from './mesh/cell-shard.js';
import { ResilienceManager, PeerHealth } from './mesh/resilience.js';

export type NodeState = 'created' | 'initializing' | 'ready' | 'running' | 'stopping' | 'stopped';

export interface P2PNodeConfig {
  /** Local peer ID (auto-generated UUID if omitted). */
  peerId?: string;
  /** H3 L9 cell hex (default: downtown Calgary 89286408597ffff). */
  h3Cell?: string;
  /** 'websocket' | 'nostr' (default: 'websocket'). */
  signalingType?: 'websocket' | 'nostr';
  /** WebSocket signaling server URL (for signalingType='websocket'). */
  signalingUrl?: string;
  /** Nostr relay URLs (for signalingType='nostr'). */
  relays?: string[];
  /** Storage implementation. Defaults to MemoryStorage. */
  storage?: IStorage;
  /** STUN/TURN servers. */
  iceServers?: ICEServer[];
  /** Heartbeat ping interval ms (default: 15000). */
  heartbeatIntervalMs?: number;
  /** Merkle sync interval ms (default: 30000). */
  syncIntervalMs?: number;
  /** Max peers per H3 L9 cell (default: 20). */
  maxPeersPerCell?: number;
  /** LRU dedup capacity for MessageRouter (default: 50000). */
  dedupCapacity?: number;
  /** Max reconnect attempts per peer (default: 5). */
  maxReconnectAttempts?: number;
}

export interface NodeStatus {
  state: NodeState;
  peerId: string;
  cell: string;
  peerCount: number;
  syncStatus: 'active' | 'idle';
  health: Record<string, PeerHealth>;
}

export interface P2PPlugin {
  install(node: P2PNode): void;
}

/**
 * P2PNode — High-level orchestrator wiring all 6 SDK layers together.
 *
 * Lifecycle: `new P2PNode(config)` → `await init()` → `await start()` → running
 *
 * Quick start:
 * ```ts
 * const node = new P2PNode({ signalingType: 'nostr', h3Cell: '89286408597ffff' });
 * await node.init();
 * await node.start();
 * node.on('peer:joined', ({ peerId }) => console.log('joined', peerId));
 * ```
 *
 * Events emitted:
 *   'ready'         ({ peerId: string })
 *   'peer:joined'   ({ peerId: string, cell: string })
 *   'peer:left'     ({ peerId: string })
 *   'sync:complete' ({ peerId: string, delta: number })
 *   'error'         (error: Error)
 */
export declare class P2PNode extends EventBus {
  readonly transport: WebRTCTransport | null;
  readonly signaling: ISignaling | null;
  readonly router: MessageRouter | null;
  readonly gossipSync: GossipSync | null;
  readonly blobTransfer: BlobTransfer | null;
  readonly cellShard: CellShard | null;
  readonly resilience: ResilienceManager | null;

  constructor(config?: P2PNodeConfig);

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Create and wire all SDK modules. Must be called before start(). */
  init(): Promise<void>;

  /** Connect signaling and start background services. */
  start(): Promise<void>;

  /** Stop background services and disconnect signaling. */
  stop(): Promise<void>;

  /** Stop (if running) and release all resources. */
  destroy(): Promise<void>;

  // ── Messaging ──────────────────────────────────────────────────────────────

  /** Publish a marketplace item and gossip to the network. */
  publishItem(item: object): Promise<string>;

  /**
   * Send a typed JSON message to a specific peer.
   */
  sendMessage(peerId: string, type: string, payload?: object): void;

  /**
   * Broadcast a typed JSON message to all connected peers.
   * @param excludePeerId - Optional peer to skip.
   */
  broadcastMessage(type: string, payload?: object, excludePeerId?: string): void;

  /**
   * Send a binary blob to a peer.
   * @returns Transfer ID
   */
  sendBlob(peerId: string, blob: ArrayBuffer | Uint8Array, meta?: object): Promise<string>;

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): NodeStatus;

  /** Return all tracked peers with their health data. */
  getPeers(): Array<PeerInfo & { health: PeerHealth | null }>;

  // ── Plugin system ──────────────────────────────────────────────────────────

  /**
   * Register a plugin.
   * If the node is already initialised, plugin.install() is called immediately.
   */
  use(plugin: P2PPlugin): this;
}
