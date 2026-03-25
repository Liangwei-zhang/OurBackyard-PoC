/**
 * @ourbackyard/p2p-sdk — TypeScript type declarations.
 *
 * All public exports mirror the barrel in sdk/src/index.js.
 */

// ── Foundation ────────────────────────────────────────────────────────────────
export { EventBus } from './src/event-bus.js';
export { uuid, ab2hex, hex2ab, sha256hex, log } from './src/utils.js';
export { Logger, LogLevel, LogLevelValue } from './src/logger.js';
export { Config, config } from './src/config.js';
export { default as defaultConfig } from './src/config.js';

// ── Identity & Crypto ─────────────────────────────────────────────────────────
export { Identity, IdentityRecord } from './src/identity.js';
export { E2ECrypto } from './src/crypto/e2e-crypto.js';
export { Signature } from './src/crypto/signature.js';
export { KeyVault } from './src/crypto/key-vault.js';

// ── Storage ───────────────────────────────────────────────────────────────────
export {
  IStorage,
  StorageRecord,
  GetAllOptions,
} from './src/storage/storage-interface.js';
export { MemoryStorage } from './src/storage/memory-storage.js';
export { IndexedDBStorage } from './src/storage/indexeddb-storage.js';

// ── Transport ─────────────────────────────────────────────────────────────────
export { ITransport } from './src/transport/transport-interface.js';
export { WebRTCTransport, ICEServer } from './src/transport/webrtc-transport.js';
export { WebSocketTransport } from './src/transport/websocket-transport.js';

// ── Signaling ─────────────────────────────────────────────────────────────────
export {
  ISignaling,
  RTCSignal,
  SignalingStatus,
} from './src/signaling/signaling-interface.js';
export { NostrSignaling } from './src/signaling/nostr-signaling.js';
export { WebSocketSignaling } from './src/signaling/websocket-signaling.js';
export { MultiSignaling } from './src/signaling/multi-signaling.js';
export { LanSignaling } from './src/signaling/lan-signaling.js';

// ── Resilience ────────────────────────────────────────────────────────────────
export { ReconnectManager } from './src/resilience/reconnect-manager.js';
export { HealthMonitor, PeerHealthRecord } from './src/resilience/health-monitor.js';
export { CircuitBreaker, BreakerState, BreakerStateValue } from './src/resilience/circuit-breaker.js';
export { RateLimiter } from './src/resilience/rate-limiter.js';

// ── Sync ──────────────────────────────────────────────────────────────────────
export {
  MessageRouter,
  Priority,
  PriorityValue,
  RouterMetrics,
} from './src/sync/message-router.js';
export {
  BlobTransfer,
  BlobPriority,
  BlobPriorityValue,
  BlobMeta,
} from './src/sync/blob-transfer.js';
export { PlumtreeGossip } from './src/sync/plumtree-gossip.js';
export { MerkleSync } from './src/sync/merkle-sync.js';
export {
  LWWRegister, LWWState,
  ORSet, ORSetState,
  GCounter, GCounterState,
  CRDTManager,
} from './src/sync/crdt.js';
export { GossipSync, MarketplaceItem } from './src/sync/gossip-sync.js';

// ── Mesh ──────────────────────────────────────────────────────────────────────
export { CellShard, PeerInfo } from './src/mesh/cell-shard.js';
export { ResilienceManager, Quality, QualityValue, PeerHealth } from './src/mesh/resilience.js';

// ── Orchestrator ──────────────────────────────────────────────────────────────
export {
  P2PNode,
  P2PNodeConfig,
  P2PPlugin,
  NodeStatus,
  NodeState,
} from './src/p2p-node.js';

// ── Application Protocols ─────────────────────────────────────────────────────
export {
  MarketplaceProtocol,
  Listing,
  Offer,
  Review,
} from './src/protocols/marketplace.js';
export { ChatProtocol, ChatMessage } from './src/protocols/chat.js';
export { FileShareProtocol, FileOffer } from './src/protocols/file-share.js';
