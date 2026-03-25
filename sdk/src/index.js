/**
 * @file index.js
 * @description P2PNode — top-level orchestrator composing all SDK layers with proper lifecycle management.
 * Zero external dependencies.
 */

import { EventBus } from './event-bus.js';
import { uuid } from './utils.js';
import { Logger } from './logger.js';
import config from './config.js';
import { Identity } from './identity.js';
import { E2ECrypto } from './crypto/e2e-crypto.js';
import { WebRTCTransport } from './transport/webrtc-transport.js';
import { MessageRouter } from './sync/message-router.js';
import { GossipSync } from './sync/gossip-sync.js';
import { BlobTransfer } from './sync/blob-transfer.js';
import { ReconnectManager } from './resilience/reconnect-manager.js';
import { HealthMonitor } from './resilience/health-monitor.js';
import { CircuitBreaker } from './resilience/circuit-breaker.js';
import { RateLimiter } from './resilience/rate-limiter.js';

const log = new Logger('P2PNode');

/**
 * @class P2PNode
 * @description Full P2P node that composes all SDK layers:
 *   Identity → Crypto → Transport → Signaling → Router → Gossip → Resilience
 *
 * @example
 * const node = new P2PNode({ signaling: new WebSocketSignaling('wss://signal.example.com') });
 * await node.start();
 * node.on('message', ({ peerId, data }) => console.log(peerId, data));
 * node.send(peerId, { type: 'chat', text: 'Hello!' });
 */
export class P2PNode extends EventBus {
  /**
   * @param {object} opts
   * @param {import('./signaling/signaling-interface.js').ISignaling} opts.signaling — signaling backend
   * @param {import('./storage/storage-interface.js').IStorage} [opts.storage] — optional persistent storage
   * @param {RTCConfiguration} [opts.rtcConfig] — ICE server configuration
   * @param {Record<string, *>} [opts.config] — config overrides
   */
  constructor(opts = {}) {
    super();
    if (!opts.signaling) throw new TypeError('opts.signaling is required');

    // Apply config overrides before constructing subsystems
    if (opts.config) config.merge(opts.config);

    this._signaling = opts.signaling;
    this._storage = opts.storage ?? null;

    // Layer 1: Identity & Crypto
    this._identity = new Identity();
    this._crypto = new E2ECrypto();

    // Layer 2: Transport
    this._transport = new WebRTCTransport({ rtcConfig: opts.rtcConfig });

    // Layer 4: Routing
    this._router = new MessageRouter();

    // Sync
    this._gossip = new GossipSync({
      broadcast: (data) => this._transport.broadcast(data),
    });
    this._blobs = new BlobTransfer({
      sendToPeer: (peerId, data) => this._transport.send(peerId, data),
    });

    // Layer 5: Resilience
    this._reconnect = new ReconnectManager({
      reconnect: (peerId) => this._reconnectPeer(peerId),
    });
    this._health = new HealthMonitor({
      sendToPeer: (peerId, data) => this._transport.send(peerId, data),
    });
    this._breaker = new CircuitBreaker();
    this._rateLimiter = new RateLimiter();

    this._started = false;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Start the P2P node: initialize identity, crypto, transport, and signaling.
   * @returns {Promise<{ id: string }>}
   */
  async start() {
    if (this._started) return { id: this._identity.id };
    log.info('Starting P2PNode...');

    // Initialize identity and crypto in parallel
    const [identity] = await Promise.all([
      this._identity.init(),
      this._crypto.init(),
    ]);

    // Wire transport events
    this._transport.on('open', ({ peerId }) => this._onPeerOpen(peerId));
    this._transport.on('message', ({ peerId, data }) => this._onMessage(peerId, data));
    this._transport.on('close', ({ peerId, reason }) => this._onPeerClose(peerId, reason));
    this._transport.on('error', ({ peerId, error }) => this.emit('peer:error', { peerId, error }));

    // Wire signaling events
    this._signaling.on('peer:announce', ({ peerId }) => this._onPeerAnnounce(peerId));
    this._signaling.on('signal', ({ from, msg }) => {
      this._transport.handleSignal(from, msg, this._signaling);
    });
    this._signaling.on('ice-config', ({ iceServers }) => {
      log.info('Received ICE config from server', iceServers);
      // Update transport ICE config for new connections
      this._transport._rtcConfig = { iceServers };
    });

    // Wire health monitor events
    this._health.on('unhealthy', ({ peerId }) => {
      log.warn(`Peer ${peerId} is unhealthy`);
      this._breaker.recordFailure(peerId, 'health-timeout');
      this.emit('peer:unhealthy', { peerId });
    });

    // Wire circuit breaker events
    this._breaker.on('open', ({ peerId }) => {
      this._reconnect.pause(peerId);
      this.emit('peer:blocked', { peerId });
    });

    // Initialize signaling
    await this._signaling.init(identity.id);
    await this._signaling.announce();

    this._health.start();
    this._started = true;

    log.info(`P2PNode started as ${identity.id}`);
    this.emit('started', { id: identity.id });
    return { id: identity.id };
  }

  /**
   * Stop the P2P node, closing all connections and releasing resources.
   */
  async stop() {
    if (!this._started) return;
    log.info('Stopping P2PNode...');
    this._health.stop();
    this._transport.close();
    this._signaling.close();
    this._started = false;
    this.emit('stopped', {});
    log.info('P2PNode stopped');
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Get the local peer ID.
   * @returns {string}
   */
  get id() { return this._identity.id; }

  /**
   * Send a JSON-serializable message to a specific peer.
   * Applies circuit breaker and rate limiter before sending.
   * @param {string} peerId
   * @param {object} message — will have id auto-assigned if not present
   * @returns {boolean} false if blocked or backpressured
   */
  send(peerId, message) {
    if (!this._breaker.allow(peerId)) {
      log.warn(`Circuit open for ${peerId} — dropping send`);
      return false;
    }
    if (!this._rateLimiter.consume(peerId)) {
      return false;
    }
    const msg = { id: message.id ?? uuid(), ...message };
    const data = JSON.stringify(msg);
    const sent = this._transport.send(peerId, data);
    if (sent) this._breaker.recordSuccess(peerId);
    return sent;
  }

  /**
   * Broadcast a message to all connected peers.
   * @param {object} message
   */
  broadcast(message) {
    const msg = { id: message.id ?? uuid(), ...message };
    const data = JSON.stringify(msg);
    this._transport.broadcast(data);
  }

  /**
   * Share a key/value pair via gossip protocol.
   * @param {string} key
   * @param {*} value
   */
  spread(key, value) {
    this._gossip.spread(key, value);
  }

  /**
   * Get a gossip-spread value.
   * @param {string} key
   * @returns {*}
   */
  gossipGet(key) {
    return this._gossip.get(key);
  }

  /**
   * Send a Blob or file to a peer.
   * @param {string} peerId
   * @param {Blob|ArrayBuffer} blob
   * @param {object} [meta]
   * @returns {Promise<void>}
   */
  sendBlob(peerId, blob, meta) {
    return this._blobs.send(peerId, blob, meta);
  }

  /**
   * Register a handler for a specific message type.
   * @param {string} type
   * @param {Function} handler
   * @returns {this}
   */
  handle(type, handler) {
    this._router.on(type, handler);
    return this;
  }

  /**
   * Return all currently connected peer IDs.
   * @returns {string[]}
   */
  peers() {
    return this._transport.peers();
  }

  // ─── Internal event handlers ──────────────────────────────────────────────────

  /** @private */
  _onPeerOpen(peerId) {
    log.info(`Peer connected: ${peerId}`);
    this._health.addPeer(peerId);
    this._reconnect.onConnect(peerId);
    this.emit('peer:connected', { peerId });
  }

  /** @private */
  _onPeerClose(peerId, reason) {
    log.info(`Peer disconnected: ${peerId} (${reason})`);
    this._health.removePeer(peerId);
    this._reconnect.onDisconnect(peerId);
    this.emit('peer:disconnected', { peerId, reason });
  }

  /** @private */
  _onPeerAnnounce(peerId) {
    if (peerId === this._identity.id) return;
    log.info(`Peer announced: ${peerId}`);
    // Initiate WebRTC connection (we are polite — they might also initiate)
    const polite = this._identity.id < peerId; // deterministic role assignment
    this._transport.connect(peerId, this._signaling, polite).catch(e => {
      log.error(`connect() failed for ${peerId}`, e);
    });
    this.emit('peer:discovered', { peerId });
  }

  /** @private */
  _onMessage(peerId, data) {
    // Circuit breaker check
    if (!this._breaker.allow(peerId)) {
      log.warn(`Dropping message from blocked peer ${peerId}`);
      return;
    }
    // Rate limiter check
    if (!this._rateLimiter.consume(peerId)) {
      this._breaker.recordFailure(peerId, 'rate-limit-exceeded');
      return;
    }

    let msg;
    try {
      msg = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      log.warn(`Invalid JSON from ${peerId}`);
      this._breaker.recordFailure(peerId, 'invalid-json');
      return;
    }

    // Health monitoring
    if (msg.type === 'health:ping') { this._health.handlePing(peerId, msg); return; }
    if (msg.type === 'health:pong') { this._health.handlePong(peerId, msg); return; }

    // Gossip forwarding
    if (msg.type === 'gossip:update') { this._gossip.handleMessage(msg); return; }

    // Blob transfer
    if (msg.type?.startsWith('blob:')) {
      this._blobs.handleMessage(msg).catch(e => log.error('BlobTransfer error', e));
      return;
    }

    // Application-level routing
    const routed = this._router.route(msg, peerId);
    if (routed) this._breaker.recordSuccess(peerId);
    this.emit('message', { peerId, data: msg });
  }

  /** @private */
  async _reconnectPeer(peerId) {
    const polite = this._identity.id < peerId;
    await this._transport.connect(peerId, this._signaling, polite);
  }
}

// Re-export all major modules for convenience
export { EventBus } from './event-bus.js';
export { uuid, sha256hex, ab2hex, hex2ab } from './utils.js';
export { Logger, LogLevel } from './logger.js';
export { config, Config } from './config.js';
export { Identity } from './identity.js';
export { E2ECrypto } from './crypto/e2e-crypto.js';
export { Signature } from './crypto/signature.js';
export { KeyVault } from './crypto/key-vault.js';
export { WebRTCTransport } from './transport/webrtc-transport.js';
export { WebSocketTransport } from './transport/websocket-transport.js';
export { ITransport } from './transport/transport-interface.js';
export { NostrSignaling } from './signaling/nostr-signaling.js';
export { WebSocketSignaling } from './signaling/websocket-signaling.js';
export { MultiSignaling } from './signaling/multi-signaling.js';
export { LANSignaling } from './signaling/lan-signaling.js';
export { ISignaling } from './signaling/signaling-interface.js';
export { MessageRouter } from './sync/message-router.js';
export { GossipSync } from './sync/gossip-sync.js';
export { BlobTransfer } from './sync/blob-transfer.js';
export { IStorage } from './storage/storage-interface.js';
export { MemoryStorage } from './storage/memory-storage.js';
export { ReconnectManager } from './resilience/reconnect-manager.js';
export { HealthMonitor } from './resilience/health-monitor.js';
export { CircuitBreaker, BreakerState } from './resilience/circuit-breaker.js';
export { RateLimiter } from './resilience/rate-limiter.js';

export default P2PNode;
