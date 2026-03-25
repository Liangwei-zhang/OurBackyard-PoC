/**
 * @ourbackyard/p2p-sdk — Public API barrel export.
 *
 * Import everything from this file:
 *   import { P2PNode, EventBus, MemoryStorage } from '@ourbackyard/p2p-sdk';
 */

// Foundation
export { EventBus } from './event-bus.js';
export { uuid, sha256hex, ab2hex, hex2ab, log } from './utils.js';
export { Logger, LogLevel } from './logger.js';
export { Config, config } from './config.js';
export { default as defaultConfig } from './config.js';

// Identity & Crypto
export { Identity } from './identity.js';
export { E2ECrypto } from './crypto/e2e-crypto.js';
export { Signature } from './crypto/signature.js';
export { KeyVault } from './crypto/key-vault.js';

// Storage
export { IStorage }         from './storage/storage-interface.js';
export { MemoryStorage }    from './storage/memory-storage.js';
export { IndexedDBStorage } from './storage/indexeddb-storage.js';

// Transport
export { ITransport } from './transport/transport-interface.js';
export { WebRTCTransport } from './transport/webrtc-transport.js';
export { WebSocketTransport } from './transport/websocket-transport.js';

// Signaling
export { ISignaling } from './signaling/signaling-interface.js';
export { NostrSignaling } from './signaling/nostr-signaling.js';
export { WebSocketSignaling } from './signaling/websocket-signaling.js';
export { MultiSignaling } from './signaling/multi-signaling.js';
export { LanSignaling } from './signaling/lan-signaling.js';

// Resilience
export { ReconnectManager } from './resilience/reconnect-manager.js';
export { HealthMonitor } from './resilience/health-monitor.js';
export { CircuitBreaker, BreakerState } from './resilience/circuit-breaker.js';
export { RateLimiter } from './resilience/rate-limiter.js';

// Sync
export { MessageRouter, Priority } from './sync/message-router.js';
export { BlobTransfer, BlobPriority } from './sync/blob-transfer.js';
export { PlumtreeGossip } from './sync/plumtree-gossip.js';
export { MerkleSync } from './sync/merkle-sync.js';
export { LWWRegister, ORSet, GCounter, CRDTManager } from './sync/crdt.js';
export { GossipSync } from './sync/gossip-sync.js';

// Mesh
export { CellShard } from './mesh/cell-shard.js';
export { ResilienceManager, Quality } from './mesh/resilience.js';

// Orchestrator
export { P2PNode } from './p2p-node.js';

// Application Protocols
export { MarketplaceProtocol } from './protocols/marketplace.js';
export { ChatProtocol } from './protocols/chat.js';
export { FileShareProtocol } from './protocols/file-share.js';
