import { EventBus } from './event-bus.js';
import { uuid } from './utils.js';
import { WebRTCTransport } from './transport/webrtc-transport.js';
import { WebSocketSignaling } from './signaling/websocket-signaling.js';
import { NostrSignaling } from './signaling/nostr-signaling.js';
import { MessageRouter } from './sync/message-router.js';
import { GossipSync } from './sync/gossip-sync.js';
import { BlobTransfer } from './sync/blob-transfer.js';
import { CellShard } from './mesh/cell-shard.js';
import { ResilienceManager } from './mesh/resilience.js';
import { MemoryStorage } from './storage/memory-storage.js';

/**
 * P2PNode — High-level orchestrator that wires all SDK modules together.
 *
 * Lifecycle: created → initializing → ready → running → stopping → stopped
 *
 * Quick start:
 *   const node = new P2PNode({ signalingUrl: 'wss://...', storage: myStorage });
 *   await node.init();
 *   await node.start();
 *   node.on('peer:joined', ({ peerId }) => console.log('Joined:', peerId));
 *
 * Events: 'ready', 'peer:joined', 'peer:left', 'sync:complete', 'error'
 */
export class P2PNode extends EventBus {
  /**
   * @param {object} [config={}]
   * @param {string}   [config.peerId]            - Local peer ID (auto-generated if omitted)
   * @param {string}   [config.h3Cell]             - H3 L9 cell hex (default: downtown Calgary)
   * @param {string}   [config.signalingType]      - 'websocket' | 'nostr'
   * @param {string}   [config.signalingUrl]       - WebSocket signaling URL (for 'websocket' type)
   * @param {string[]} [config.relays]             - Nostr relay URLs (for 'nostr' type)
   * @param {import('./storage/storage-interface.js').IStorage} [config.storage] - Storage implementation
   * @param {object[]} [config.iceServers]         - STUN/TURN server list
   * @param {number}   [config.heartbeatIntervalMs] - Heartbeat ping interval (default: 15000)
   * @param {number}   [config.syncIntervalMs]     - Merkle sync interval (default: 30000)
   * @param {number}   [config.maxPeersPerCell]    - Cell density limit (default: 20)
   */
  constructor(config = {}) {
    super();
    this._config  = this._validateConfig(config);
    this._state   = 'created';
    /** @type {Array<{install: Function}>} */
    this._plugins = [];

    // Module references (populated during init())
    this.transport  = null;
    this.signaling  = null;
    this.router     = null;
    this.gossipSync = null;
    this.blobTransfer = null;
    this.cellShard  = null;
    this.resilience = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Create and wire all SDK modules.
   * Must be called before start().
   * @returns {Promise<void>}
   */
  async init() {
    if (this._state !== 'created') throw new Error(`init() called in invalid state: ${this._state}`);
    this._state = 'initializing';

    const cfg = this._config;

    // 1. Transport
    this.transport = new WebRTCTransport({
      peerId:     cfg.peerId,
      iceServers: cfg.iceServers,
    });

    // 2. Signaling
    this.signaling = this._createSignaling(cfg);

    // 3. Message router
    this.router = new MessageRouter({
      dedupCapacity: cfg.dedupCapacity,
    });

    // 4. GossipSync
    this.gossipSync = new GossipSync({
      router:         this.router,
      storage:        cfg.storage,
      peerId:         cfg.peerId,
      syncIntervalMs: cfg.syncIntervalMs,
    });

    // 5. BlobTransfer
    this.blobTransfer = new BlobTransfer({
      router: this.router,
      peerId: cfg.peerId,
    });

    // 6. CellShard
    this.cellShard = new CellShard({
      peerId:          cfg.peerId,
      h3Cell:          cfg.h3Cell,
      maxPeersPerCell: cfg.maxPeersPerCell,
    });

    // 7. ResilienceManager
    this.resilience = new ResilienceManager({
      router:                this.router,
      transport:             this.transport,
      heartbeatIntervalMs:   cfg.heartbeatIntervalMs,
      maxReconnectAttempts:  cfg.maxReconnectAttempts,
    });

    // 8. Wire event flows
    this._wireEvents();

    // 9. Install plugins
    for (const plugin of this._plugins) {
      if (typeof plugin.install === 'function') plugin.install(this);
    }

    this._state = 'ready';
    this.emit('ready', { peerId: cfg.peerId });
  }

  /**
   * Connect signaling and start all background services.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._state !== 'ready') throw new Error(`start() called in invalid state: ${this._state}`);
    this._state = 'running';

    // Connect signaling
    await this.signaling.connect();
    await this.signaling.announce({ h3Cell: this._config.h3Cell });

    // Wire send function through transport
    const sendFn = (peerId, msg) => {
      const data = JSON.stringify(msg);
      this.transport.send(peerId, data);
    };
    this.gossipSync.setSendFn(sendFn);
    this.resilience.setSendFn(sendFn);

    // Start resilience monitoring
    this.resilience.startMonitoring();

    // Start gossip sync
    this.gossipSync.startSync(() => this.cellShard.getNearbyPeers().map(p => p.peerId));
  }

  /**
   * Stop all background services and disconnect signaling.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._state !== 'running') return;
    this._state = 'stopping';

    this.gossipSync.stopSync();
    this.resilience.stopMonitoring();
    await this.signaling.disconnect();

    this._state = 'stopped';
  }

  /**
   * Clean up all resources.
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._state === 'running') await this.stop();
    if (this.transport) this.transport.destroyAll?.();
    this.removeAllListeners?.();
    this._state = 'stopped';
  }

  // ── Convenience API ───────────────────────────────────────────────────────

  /**
   * Publish a marketplace item to the P2P network.
   * @param {object} item
   * @returns {Promise<string>} Message ID
   */
  async publishItem(item) {
    this._assertRunning();
    return this.gossipSync.publishItem(item);
  }

  /**
   * Send a typed message to a specific peer.
   * @param {string} peerId
   * @param {string} type
   * @param {object} [payload={}]
   */
  sendMessage(peerId, type, payload = {}) {
    this._assertRunning();
    const msg = { type, id: uuid(), ...payload };
    const data = JSON.stringify(msg);
    this.transport.send(peerId, data);
  }

  /**
   * Broadcast a typed message to all connected peers.
   * @param {string} type
   * @param {object} [payload={}]
   * @param {string} [excludePeerId]
   */
  broadcastMessage(type, payload = {}, excludePeerId) {
    this._assertRunning();
    const msg = { type, id: uuid(), ...payload };
    const data = JSON.stringify(msg);
    this.transport.broadcast(data, excludePeerId);
  }

  /**
   * Send a binary blob to a peer.
   * @param {string} peerId
   * @param {ArrayBuffer|Uint8Array} blob
   * @param {object} [meta={}]
   * @returns {Promise<string>} Transfer ID
   */
  async sendBlob(peerId, blob, meta = {}) {
    this._assertRunning();
    return this.blobTransfer.send(peerId, blob, meta);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  /**
   * Return a status snapshot of the node.
   * @returns {{state: string, peerId: string, cell: string, peerCount: number, syncStatus: string, health: object}}
   */
  getStatus() {
    return {
      state:      this._state,
      peerId:     this._config.peerId,
      cell:       this._config.h3Cell,
      peerCount:  this.cellShard ? this.cellShard.getAllPeers().length : 0,
      syncStatus: this._state === 'running' ? 'active' : 'idle',
      health:     this.resilience ? Object.fromEntries(this.resilience.getAllHealth()) : {},
    };
  }

  /**
   * Return merged peer info from cellShard + resilience.
   * @returns {Array<object>}
   */
  getPeers() {
    if (!this.cellShard) return [];
    return this.cellShard.getAllPeers().map(peer => ({
      ...peer,
      health: this.resilience ? this.resilience.getPeerHealth(peer.peerId) : null,
    }));
  }

  // ── Plugin system ─────────────────────────────────────────────────────────

  /**
   * Register a plugin. If the node is already initialised, install() is called immediately.
   * @param {{install: Function}} plugin
   * @returns {this}
   */
  use(plugin) {
    this._plugins.push(plugin);
    if (this._state !== 'created' && typeof plugin.install === 'function') {
      plugin.install(this);
    }
    return this;
  }

  // ── Internal wiring ───────────────────────────────────────────────────────

  /** @private */
  _wireEvents() {
    const cfg = this._config;

    // Transport data → router
    this.transport.on('data', (fromPeerId, raw) => {
      try {
        const msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
        this.router.route(fromPeerId, msg).catch(() => {});
      } catch {
        // ignore malformed messages
      }
    });

    // Transport peer connected
    this.transport.on('peer:connected', (peerId) => {
      this.gossipSync.addPeer(peerId);
      this.resilience.trackPeer(peerId);
      this.emit('peer:joined', { peerId });
      // Trigger immediate Merkle sync instead of waiting up to 30s for periodic timer
      this.gossipSync.syncWithPeer(peerId).catch(() => {});
    });

    // Transport peer disconnected
    this.transport.on('peer:disconnected', (peerId) => {
      this.gossipSync.removePeer(peerId);
      this.emit('peer:left', { peerId });
    });

    // Signaling: forward ICE/SDP signals
    this.transport.on('signal:send', (targetPeerId, signal) => {
      this.signaling.sendSignal(targetPeerId, signal).catch(() => {});
    });

    // Signaling: incoming ICE/SDP
    this.signaling.on('signal', (fromPeerId, signal) => {
      this.transport.handleSignal?.(fromPeerId, signal);
    });

    // Signaling: new peer announced
    // Use a seen-set so we only re-announce for genuinely NEW peers (first sight).
    // Re-announcing on every heartbeat from a known peer causes a positive-feedback storm:
    // A announces → B re-announces → A re-announces → ... (all 7 relays × 15s = rate-limited).
    const _seenPeers = new Set();
    this.signaling.on('peer:announce', (peerId, meta) => {
      if (peerId === cfg.peerId) return;
      const h3Cell = meta?.h3Cell;
      if (h3Cell) this.cellShard.addPeer(peerId, h3Cell);
      this.transport.connect(peerId, cfg.peerId < peerId).catch(() => {});
      // Re-announce once per peer so they know we exist, but never again on heartbeats.
      if (!_seenPeers.has(peerId)) {
        _seenPeers.add(peerId);
        this.signaling.announce({ h3Cell: cfg.h3Cell }).catch(() => {});
      }
    });

    // CellShard events
    this.cellShard.on('cell:split', (data) => {
      this.emit('cell:split', data);
    });

    // GossipSync events
    this.gossipSync.on('sync:completed', (data) => {
      this.emit('sync:complete', data);
    });

    // Resilience events
    this.resilience.on('peer:dead', ({ peerId }) => {
      this.emit('error', { type: 'peer:dead', peerId });
    });
  }

  /** @private */
  _createSignaling(cfg) {
    if (cfg.signalingType === 'nostr') {
      return new NostrSignaling({
        peerId: cfg.peerId,
        h3Cell: cfg.h3Cell,
        relays: cfg.relays,
      });
    }
    // Default: WebSocket
    return new WebSocketSignaling({
      url:    cfg.signalingUrl || 'ws://localhost:8765',
      peerId: cfg.peerId,
    });
  }

  /** @private */
  _validateConfig(config) {
    return {
      peerId:               config.peerId      || uuid(),
      h3Cell:               config.h3Cell      || '8f283082affffff',
      signalingType:        config.signalingType || 'websocket',
      signalingUrl:         config.signalingUrl  || null,
      relays:               config.relays        || null,
      storage:              config.storage       || new MemoryStorage(),
      iceServers:           config.iceServers    || [{ urls: 'stun:stun.l.google.com:19302' }],
      heartbeatIntervalMs:  config.heartbeatIntervalMs  || 15000,
      syncIntervalMs:       config.syncIntervalMs        || 30000,
      maxPeersPerCell:      config.maxPeersPerCell        || 20,
      maxReconnectAttempts: config.maxReconnectAttempts   || 5,
      dedupCapacity:        config.dedupCapacity          || 10000,
      ...config,
    };
  }

  /** @private */
  _assertRunning() {
    if (this._state !== 'running') {
      throw new Error(`Node is not running (state: ${this._state}). Call start() first.`);
    }
  }
}
