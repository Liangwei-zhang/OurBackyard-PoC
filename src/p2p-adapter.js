/**
 * OurBackyard P2P Adapter — SDK-powered drop-in for native/communication/p2p-mesh.js
 *
 * Replaces the custom OurBackyardMesh + NostrSignaling implementations with the
 * @ourbackyard/p2p-sdk, while maintaining full API compatibility with index.html.
 *
 * Key API preserved:
 *   new OurBackyardMesh({ peerId, h3Cell, db, onItem, onChat, onPeers, onStatus })
 *   await mesh.init()
 *   mesh.broadcastItem(item)
 *   mesh.broadcastItemUpdate(itemId, status)
 *   mesh.sendChat(toPeerId, text, itemId, opts)
 *   mesh.signaling.isOnline
 *   mesh.lanChannel
 *   window.dataChannels[peerId]  — proxy DataChannels bridging to SDK transport
 */

import { P2PNode } from '../sdk/src/p2p-node.js';

// ── ICE servers shared by the adapter ───────────────────────────────────────
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];

// Message types handled entirely inside the SDK layer
// For these types, we do NOT re-route to window.handleMessage to avoid double-processing.
const SDK_HANDLED_TYPES = new Set([
  'GOSSIP_PUSH', 'GOSSIP_IHAVE', 'GOSSIP_GRAFT', 'GOSSIP_PRUNE',
  'SYNC_STATE', 'SYNC_DIFF', 'SYNC_REQUEST', 'SYNC_RESPONSE',
  'BLOB_REQ', 'BLOB_RESP', 'BLOB_STREAM_START', 'BLOB_STREAM_END',
  'HEARTBEAT_PING', 'HEARTBEAT_PONG',
]);

/**
 * SDK-backed OurBackyardMesh — drop-in replacement for native/communication/p2p-mesh.js.
 *
 * Internally initialises a P2PNode (6-layer SDK) and bridges its WebRTC DataChannels
 * to the existing window.dataChannels / window.handleMessage interface.
 */
class OurBackyardMesh {
  /**
   * @param {object} opts
   * @param {string}   opts.peerId     — local peer ID
   * @param {string}   opts.h3Cell     — H3 L9 hex cell (geographic channel)
   * @param {object}   [opts.db]       — Dexie instance (used for dead-drop, optional)
   * @param {Function} [opts.onItem]   — callback(item) when new item received via gossip
   * @param {Function} [opts.onChat]   — callback(msg) when chat message arrives
   * @param {Function} [opts.onPeers]  — callback(count) when peer count changes
   * @param {Function} [opts.onStatus] — callback(mode) 'nostr'|'lan'|'offline'
   */
  constructor({ peerId, h3Cell, db, onItem, onChat, onPeers, onStatus } = {}) {
    this.peerId   = peerId;
    this.h3Cell   = h3Cell || 'default';
    this.db       = db || null;
    this.onItem   = onItem   || null;
    this.onChat   = onChat   || null;    // ChatUI will overwrite this after init
    this.onPeers  = onPeers  || null;
    this.onStatus = onStatus || null;
    this.options  = {};                   // LocalAI patches options.onItem

    // Exposed compatibility properties (real signaling set in init())
    this.signaling  = { isOnline: false, sendSignal: async () => {} };
    this.lanChannel = null;

    // Internal SDK node
    this._node = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async init() {
    this._node = new P2PNode({
      peerId:        this.peerId,
      h3Cell:        this.h3Cell,
      signalingType: 'nostr',
      relays:        null, // use NostrSignaling defaults
      iceServers:    ICE_SERVERS,
    });

    await this._node.init();
    // Expose the real SDK signaling so callers can use signaling.sendSignal() and signaling.isOnline
    this.signaling = this._node.signaling;
    this._wireNodeEvents();
    this._initLAN();
    await this._node.start();

    console.log('[SDK Mesh] Initialised, peerId:', this.peerId, 'cell:', this.h3Cell);
    return this;
  }

  // ── Event wiring ─────────────────────────────────────────────────────────────

  _wireNodeEvents() {
    const node = this._node;

    // Synchronise signaling online status callback
    node.signaling.on('status', (status) => {
      this.onStatus?.(status === 'online' ? 'nostr' : 'offline');
    });

    // New peer connected → bridge DataChannel proxy + notify
    node.on('peer:joined', ({ peerId }) => {
      this._bridgePeer(peerId);
      const count = node.cellShard.getAllPeers().length;
      this.onPeers?.(count);
      // Also update the inline-script peer tracking
      if (typeof window !== 'undefined' && typeof window.trackPeer === 'function') {
        window.trackPeer(peerId);
      }
    });

    // Peer disconnected → remove bridge + notify
    node.on('peer:left', ({ peerId }) => {
      this._unbridgePeer(peerId);
      const count = node.cellShard.getAllPeers().length;
      this.onPeers?.(count);
    });

    // Item received via GossipSync (plumtree broadcast)
    node.gossipSync.on('item:received', ({ payload }) => {
      if (!payload) return;
      // options.onItem may be patched by LocalAI
      if (this.options?.onItem) {
        this.options.onItem(payload);
      } else {
        this.onItem?.(payload);
      }
    });

    // Unhandled message types → forward to inline handleMessage
    node.router.on('route:unhandled', (type, fromPeerId, msg) => {
      if (typeof window === 'undefined') return;

      // CHAT messages: invoke onChat callback
      if (type === 'CHAT') {
        const chatMsg = { ...msg, direction: 'in', from: fromPeerId };
        this.onChat?.(chatMsg);
        return;
      }

      // CHAT_READ: forward to ChatUI if bound
      if (type === 'CHAT_READ') {
        if (this.onChat) this.onChat({ type: 'read', msgId: msg.msgId });
        return;
      }

      // NEW_ITEM / ITEM: treat as gossip item
      if (type === 'NEW_ITEM' || type === 'ITEM') {
        const item = msg.item;
        if (item) {
          if (this.options?.onItem) this.options.onItem(item);
          else this.onItem?.(item);
        }
        return;
      }

      // Skip SDK-internal types
      if (SDK_HANDLED_TYPES.has(type)) return;

      // Everything else → inline handleMessage (ITEM_UPDATE, peer-joined, etc.)
      if (typeof window.handleMessage === 'function') {
        window.handleMessage(JSON.stringify(msg)).catch?.(() => {});
      }
    });
  }

  // ── LAN BroadcastChannel (same-device / same-browser testing) ────────────────

  _initLAN() {
    try {
      // Use L7 channel key to match peers in the same ~5 km² area
      const l7 = this._toL7(this.h3Cell);
      this.lanChannel = new BroadcastChannel(`ourbackyard:${l7}`);
      this.lanChannel.onmessage = (e) => this._handleLANMsg(e.data);
      this._lanAnnounce();
      this.onStatus?.('lan');
    } catch (e) {
      console.warn('[SDK Mesh] BroadcastChannel not available:', e.message);
    }
  }

  _lanAnnounce() {
    this.lanChannel?.postMessage({
      type:   'ANNOUNCE',
      peerId: this.peerId,
      h3:     this.h3Cell,
      ts:     Date.now(),
    });
  }

  _handleLANMsg(data) {
    if (!data || data.peerId === this.peerId) return;
    // Basic validation to prevent injection
    if (typeof data.peerId !== 'string' || data.peerId.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(data.peerId)) return;

    if (data.type === 'ANNOUNCE' && this._node) {
      // Initiate WebRTC via SDK transport (lexicographic ordering to avoid glare)
      const shouldOffer = this.peerId < data.peerId;
      this._node.transport.connect(data.peerId, shouldOffer).catch(() => {});
    } else if (data.type === 'SIGNAL' && data.target === this.peerId && this._node) {
      this._node.transport.handleSignal(data.from, data.signal).catch?.(() => {});
    }
  }

  // ── DataChannel Bridge ────────────────────────────────────────────────────────
  // Allows the existing inline code (sendToPeer, MerkleSync, handleMessage) to
  // continue working with SDK-managed connections via proxy objects in window.dataChannels.

  _bridgePeer(peerId) {
    if (typeof window === 'undefined') return;
    window.dataChannels = window.dataChannels || {};

    const transport = this._node.transport;
    window.dataChannels[peerId] = {
      readyState: 'open',
      send(data) {
        try { transport.send(peerId, data); }
        catch (e) { console.warn('[SDK Mesh] send to', peerId, 'failed:', e.message); }
      },
    };
  }

  _unbridgePeer(peerId) {
    if (typeof window !== 'undefined' && window.dataChannels) {
      delete window.dataChannels[peerId];
    }
  }

  // ── Public API (mirroring OurBackyardMesh) ────────────────────────────────────

  /**
   * Broadcast a new listing to all neighbours via plumtree gossip.
   * @param {object} item    — marketplace listing object
   * @param {number} [ttl=4] — gossip time-to-live
   */
  broadcastItem(item, ttl = 4) {
    if (!this._node) return;
    // SDK plumtree publish (handles dedup + lazy-push automatically)
    this._node.publishItem(item).catch(e =>
      console.warn('[SDK Mesh] broadcastItem failed:', e.message)
    );
    // Also flood as NEW_ITEM so the inline handleMessage sees it
    this._node.broadcastMessage('NEW_ITEM', { item, ttl }).catch?.(() => {});
  }

  /**
   * Broadcast a status update for an existing listing.
   * @param {string|number} itemId
   * @param {string} status — 'available'|'pending'|'gone'
   */
  broadcastItemUpdate(itemId, status) {
    if (!this._node) return;
    this._node.broadcastMessage('ITEM_UPDATE', {
      itemId,
      status,
      ts:   Date.now(),
      from: this.peerId,
    });
  }

  /**
   * Send a chat message directly to a peer.
   * E2E encryption is handled by the existing key-vault layer if available.
   * @param {string} toPeerId
   * @param {string} text
   * @param {string|null} itemId
   * @param {object} [opts] — extra options (e.g. mediaType for voice/photo)
   * @returns {Promise<void>}
   */
  async sendChat(toPeerId, text, itemId, opts = {}) {
    if (!this._node) return;
    const msg = {
      type:      'CHAT',
      from:      this.peerId,
      to:        toPeerId,
      text,
      itemId:    itemId || null,
      ts:        Date.now(),
      direction: 'out',
      ...opts,
    };
    try {
      this._node.sendMessage(toPeerId, 'CHAT', msg);
    } catch (e) {
      console.warn('[SDK Mesh] sendChat failed:', e.message);
    }
  }

  // ── H3 cell helper (L9 → L7) ─────────────────────────────────────────────────
  // Mirrors NostrSignaling._toL7 (no h3-js dependency required).

  _toL7(h3CellHex) {
    try {
      if (!h3CellHex || h3CellHex === 'default') return h3CellHex;
      const normalized = String(h3CellHex).padStart(15, '0');
      const cell = BigInt('0x' + normalized);
      let digitMask = 0n;
      for (let d = 7; d < 15; d++) {
        const shift = BigInt(44 - d * 3);
        digitMask |= (7n << shift);
      }
      const resMask = 0xFn << 52n;
      const l7 = (cell & ~resMask & ~digitMask) | (7n << 52n) | digitMask;
      return l7.toString(16).padStart(15, '0');
    } catch {
      return h3CellHex;
    }
  }
}

// ── Expose as global (replaces native/communication/p2p-mesh.js) ─────────────
if (typeof window !== 'undefined') {
  window.OurBackyardMesh = OurBackyardMesh;
  console.log('[SDK Mesh] OurBackyardMesh registered (SDK v0.1)');
}
