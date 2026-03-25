/**
 * P2PNode — Top-level orchestrator for the @ourbackyard/p2p-sdk.
 *
 * Composes: EventBus + WebRTCTransport + ISignaling + MessageRouter +
 *           GossipSync + BlobTransfer + E2ECrypto
 *
 * Quick start:
 *   import { P2PNode } from '@ourbackyard/p2p-sdk';
 *   import { NostrSignaling } from '@ourbackyard/p2p-sdk/signaling';
 *
 *   const node = new P2PNode({
 *     peerId:   'alice-123',
 *     signaling: new NostrSignaling({ peerId: 'alice-123', h3Cell: myCell }),
 *     storage:   myStorage,          // IStorage implementation
 *     iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
 *   });
 *
 *   await node.start();
 *   node.on('peer:connected',    peer => console.log('Connected:', peer));
 *   node.on('peer:disconnected', peer => console.log('Gone:', peer));
 *   node.on('message',           msg  => console.log('Message:', msg));
 *   node.on('item:new',          item => renderItem(item));
 *
 *   node.broadcast('ITEM', { item: myItem });
 *   node.send('bob-456', 'CHAT', { text: 'Hello!' });
 *   await node.stop();
 *
 * Events emitted (in addition to module-level events):
 *   'peer:connected'    (peerId)
 *   'peer:disconnected' (peerId)
 *   'message'           ({ type, from, ...payload })
 *   'item:new'          (item)
 *   'item:update'       (itemId, status)
 *   'blob:received'     (hash, blob)
 *   'sync:complete'     (peerId, count)
 *   'status'            ('online'|'offline'|'searching')
 */

import { EventBus }          from './event-bus.js';
import { WebRTCTransport }   from './transport/webrtc-transport.js';
import { MessageRouter }     from './sync/message-router.js';
import { GossipSync }        from './sync/gossip-sync.js';
import { BlobTransfer }      from './sync/blob-transfer.js';
import { E2ECrypto }         from './crypto/e2e-crypto.js';

export class P2PNode extends EventBus {
  /**
   * @param {object} opts
   * @param {string}   opts.peerId       — Unique identifier for this node
   * @param {import('./signaling/signaling-interface.js').ISignaling} opts.signaling
   * @param {import('./storage/storage-interface.js').IStorage} [opts.storage]
   * @param {object[]} [opts.iceServers] — RTCIceServer array (no TURN creds baked in)
   * @param {number}   [opts.maxPeers=12]
   * @param {object}   [opts.transport]  — Override WebRTCTransport config
   */
  constructor({ peerId, signaling, storage, iceServers = [], maxPeers = 12, transport: transportOpts = {} }) {
    super();

    if (!peerId) throw new Error('P2PNode: peerId is required');
    if (!signaling) throw new Error('P2PNode: signaling is required');

    this.peerId    = peerId;
    this._signaling = signaling;
    this._storage   = storage ?? null;

    // --- Transport layer ---
    this._transport = new WebRTCTransport({
      peerId,
      iceServers,
      maxPeers,
      ...transportOpts,
    });

    // --- Message router (sits above transport) ---
    this._router = new MessageRouter({ transport: this._transport });

    // --- Sync modules (injected into router) ---
    this._gossip = storage
      ? new GossipSync({ router: this._router, storage, peerId })
      : null;

    this._blobs = storage
      ? new BlobTransfer({ router: this._router, storage })
      : null;

    // --- E2E Crypto ---
    this._crypto = new E2ECrypto();

    // --- Wire up events ---
    this._wireTransport();
    this._wireSignaling();
    this._wireCrypto();
    this._wireSync();
  }

  // ─────────────────────────── Lifecycle ───────────────────────────

  /**
   * Start the node: initialise crypto, connect signaling, announce presence.
   */
  async start() {
    await this._crypto.init();
    await this._signaling.connect();
    await this._signaling.announce({ ecdhPub: this._crypto.getPublicKeyHex() });
  }

  /**
   * Gracefully stop the node.
   */
  async stop() {
    await this._signaling.disconnect();
    this._transport.destroy();
    this.removeAllListeners();
  }

  // ─────────────────────────── Public send API ───────────────────────────

  /**
   * Send a typed message to a single peer.
   * @param {string} peerId
   * @param {string} type
   * @param {object} [payload]
   * @returns {boolean}
   */
  send(peerId, type, payload = {}) {
    return this._router.send(peerId, type, payload);
  }

  /**
   * Broadcast a typed message to all connected peers.
   * @param {string} type
   * @param {object} [payload]
   * @param {string} [excludePeerId]
   */
  broadcast(type, payload = {}, excludePeerId) {
    this._router.broadcast(type, payload, excludePeerId);
  }

  /**
   * Broadcast a new item via gossip (shorthand).
   * @param {object} item
   */
  broadcastItem(item) {
    this._gossip?.broadcastItem(item);
  }

  /** @returns {string[]} */
  get connectedPeers() { return this._transport.connectedPeers; }

  /** @returns {number} */
  get peerCount() { return this._transport.peerCount; }

  // ─────────────────────────── Wiring ───────────────────────────

  _wireTransport() {
    this._transport.on('peer:connected', (peerId) => {
      this.emit('peer:connected', peerId);
      // Request item sync from newly connected peer
      this._gossip?.requestSync(peerId).catch(() => {});
    });

    this._transport.on('peer:disconnected', (peerId) => {
      this.emit('peer:disconnected', peerId);
    });

    // Re-emit raw 'data' as typed 'message' events (for unregistered types)
    // Registered types are handled by MessageRouter — only unhandled ones bubble up here.
  }

  _wireSignaling() {
    // Relay WebRTC signals to transport
    this._transport.on('signal:send', (targetPeerId, signal) => {
      // Attach our ECDH public key to offer/answer so remote can derive shared key
      if (signal.type === 'offer' || signal.type === 'answer') {
        signal.ecdhPub = this._crypto.getPublicKeyHex();
      }
      this._signaling.sendSignal(targetPeerId, signal).catch(() => {});
    });

    // Incoming signals from signaling layer → transport
    this._signaling.on('signal', (fromPeerId, signal) => {
      // Handle ECDH key exchange piggy-backed on offer/answer
      if (signal.ecdhPub) {
        this._crypto.deriveSharedKey(fromPeerId, signal.ecdhPub).catch(() => {});
      }
      this._transport.handleSignal(fromPeerId, signal).catch(() => {});
    });

    // Peer discovery: initiate offer if we are lexicographically first
    this._signaling.on('peer:announce', (peerId, meta) => {
      if (peerId === this.peerId) return;
      // Store ECDH key if present in announcement
      if (meta.ecdhPub) {
        this._crypto.deriveSharedKey(peerId, meta.ecdhPub).catch(() => {});
      }
      this._transport.trackPeer(peerId, meta);
      if (this.peerId < peerId && !this._transport.hasPeerConnection(peerId)) {
        this._transport.createOffer(peerId).catch(() => {});
      }
    });

    // Relay signaling status
    this._signaling.on('status', (status) => {
      this.emit('status', status);
    });

    // If the server pushes updated ICE config (TURN credentials), adopt them
    this._signaling.on('ice-config', (config) => {
      if (Array.isArray(config.iceServers)) {
        this._transport.iceServers = config.iceServers;
      }
    });
  }

  _wireCrypto() {
    // When a shared key becomes available, register the ECDH_PUB handler
    // so that peers can exchange keys over the DataChannel too
    this._router.handle('ECDH_PUB', (fromPeerId, msg) => {
      if (msg.ecdhPub) {
        this._crypto.deriveSharedKey(fromPeerId, msg.ecdhPub).catch(() => {});
      }
    });

    // On connection, immediately send our ECDH public key over DataChannel
    this._transport.on('peer:connected', (peerId) => {
      try {
        this._transport.send(peerId, JSON.stringify({
          type:    'ECDH_PUB',
          from:    this.peerId,
          ecdhPub: this._crypto.getPublicKeyHex(),
        }));
      } catch {}
    });
  }

  _wireSync() {
    // Bubble sync events up
    if (this._gossip) {
      this._gossip.on('item:new',      (...a) => this.emit('item:new',      ...a));
      this._gossip.on('item:update',   (...a) => this.emit('item:update',   ...a));
      this._gossip.on('sync:complete', (...a) => this.emit('sync:complete', ...a));
    }
    if (this._blobs) {
      this._blobs.on('blob:received', (...a) => this.emit('blob:received', ...a));
      this._blobs.on('blob:progress', (...a) => this.emit('blob:progress', ...a));
    }

    // Catch-all for message types not claimed by GossipSync / BlobTransfer
    this._transport.on('data', (fromPeerId, data) => {
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg?.type) this.emit('message', { from: fromPeerId, ...msg });
        } catch {}
      }
    });
  }
}

// Re-export all sub-modules for convenience
export { EventBus }           from './event-bus.js';
export { WebRTCTransport }    from './transport/webrtc-transport.js';
export { ISignaling }         from './signaling/signaling-interface.js';
export { NostrSignaling }     from './signaling/nostr-signaling.js';
export { WebSocketSignaling } from './signaling/websocket-signaling.js';
export { MessageRouter }      from './sync/message-router.js';
export { GossipSync }         from './sync/gossip-sync.js';
export { BlobTransfer }       from './sync/blob-transfer.js';
export { E2ECrypto }          from './crypto/e2e-crypto.js';
export { IStorage }           from './storage/storage-interface.js';
export { MemoryStorage }      from './storage/memory-storage.js';
export { uuid, ab2hex, hex2ab, sha256hex } from './utils.js';
