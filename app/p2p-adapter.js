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
import { IndexedDBStorage } from '../sdk/src/storage/indexeddb-storage.js';
import { MemoryStorage } from '../sdk/src/storage/memory-storage.js';
import { MarketplaceProtocol } from '../sdk/src/protocols/marketplace.js';

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
  // PlumtreeGossip — actual type strings from sdk/src/sync/plumtree-gossip.js
  'GOSSIP_MSG', 'IHAVE', 'IWANT', 'GRAFT', 'PRUNE',
  // MerkleSync — actual type strings used in sdk/src/sync/merkle-sync.js
  'SYNC_REQ', 'SYNC_RESP', 'SYNC_TREE_REQ', 'SYNC_TREE_RESP',
  'SYNC_ITEMS_REQ', 'SYNC_ITEMS_RESP',
  // Legacy aliases (kept for compatibility)
  'SYNC_STATE', 'SYNC_DIFF', 'SYNC_REQUEST', 'SYNC_RESPONSE',
  // BlobTransfer
  'BLOB_REQ', 'BLOB_RESP', 'BLOB_STREAM_START', 'BLOB_STREAM_END',
  'BLOB_HEADER', 'BLOB_CHUNK', 'BLOB_ACK',
  // ResilienceManager
  'HEARTBEAT_PING', 'HEARTBEAT_PONG',
  // CRDT
  'CRDT_LWWREG', 'CRDT_ORSET', 'CRDT_GCOUNTER',
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
    // Use IndexedDB for persistence; fall back to MemoryStorage if unavailable
    let storage;
    try {
      // DB name is scoped to the H3 cell so different geographic zones don't share state
      storage = new IndexedDBStorage(`${this.h3Cell}`);
      // Eagerly open to surface any errors before the node starts
      await storage._ready;
    } catch (e) {
      console.warn('[SDK Mesh] IndexedDB unavailable, using MemoryStorage:', e.message);
      storage = new MemoryStorage();
    }
    this._storage = storage;

    this._node = new P2PNode({
      peerId:        this.peerId,
      h3Cell:        this.h3Cell,
      signalingType: 'nostr',
      relays:        null, // use NostrSignaling defaults
      iceServers:    ICE_SERVERS,
      storage,
    });

    await this._node.init();
    // Install MarketplaceProtocol so LISTING_NEW / LISTING_UPDATE messages from remote
    // peers are handled by the SDK router (LWW merge, storage persistence, item:received
    // event emission) rather than falling through to window.handleMessage.
    this._marketplace = new MarketplaceProtocol(this._node);
    this._node.use(this._marketplace);
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

    // Adapter-level item dedup: same logical item may arrive via multiple paths
    // (PlumtreeGossip broadcast + MerkleSync reconciliation + NEW_ITEM route:unhandled).
    // A 5-second window collapses duplicates before they reach saveNeighborItem() / Dexie.
    const _seenItems = new Map(); // itemId → timestamp
    const ITEM_DEDUP_MS = 5000;
    const _deduplicatedOnItem = (item) => {
      if (!item?.id) {
        if (this.options?.onItem) this.options.onItem(item);
        else this.onItem?.(item);
        return;
      }
      const now = Date.now();
      const last = _seenItems.get(item.id);
      if (last && now - last < ITEM_DEDUP_MS) {
        console.log('[SDK Mesh] Dedup: skipping duplicate item within 5s window, id:', item.id);
        return;
      }
      _seenItems.set(item.id, now);
      // Periodic cleanup to prevent unbounded growth
      if (_seenItems.size > 300) {
        for (const [k, t] of _seenItems) {
          if (now - t > ITEM_DEDUP_MS) _seenItems.delete(k);
        }
      }
      if (this.options?.onItem) this.options.onItem(item);
      else this.onItem?.(item);
    };

    // Synchronise signaling online status callback
    node.signaling.on('status', (status) => {
      this.onStatus?.(status === 'online' ? 'nostr' : 'offline');
    });

    // New peer connected → bridge DataChannel proxy + notify
    node.on('peer:joined', ({ peerId }) => {
      this._bridgePeer(peerId);
      const count = node.transport?.peerCount ?? node.cellShard.getAllPeers().length;
      this.onPeers?.(count);
      // Also update the inline-script peer tracking
      if (typeof window !== 'undefined' && typeof window.trackPeer === 'function') {
        window.trackPeer(peerId);
      }
    });

    // Peer disconnected → remove bridge + notify
    node.on('peer:left', ({ peerId }) => {
      this._unbridgePeer(peerId);
      const count = node.transport?.peerCount ?? node.cellShard.getAllPeers().length;
      this.onPeers?.(count);
    });

    // Item received via GossipSync (plumtree broadcast)
    node.gossipSync.on('item:received', ({ payload }) => {
      if (!payload) return;
      console.log('[SDK Mesh] item:received:', payload?.title || payload?.id, 'id:', payload?.id);
      _deduplicatedOnItem(payload);
    });

    // Reconciliation fallback: if MerkleSync reports 0 new items but UI DB was cleared,
    // replay canonical SDK items through the same onItem pipeline.
    node.gossipSync.on('sync:completed', async ({ itemsSynced }) => {
      if (itemsSynced !== 0) return;
      if (typeof window === 'undefined' || !window.db?.items) return;
      try {
        const sdkItems = await this._storage?.getByPrefix?.('item:');
        if (!sdkItems || sdkItems.length === 0) return;
        const dexieCount = await window.db.items.where('status').notEqual('gone').count();
        if (dexieCount > 0) return;

        console.log('[SDK Mesh] Dexie empty while SDK storage has items, replaying to UI:', sdkItems.length);
        for (const { value } of sdkItems) {
          if (value && value.id) _deduplicatedOnItem(value);
        }
      } catch (e) {
        console.warn('[SDK Mesh] sync:completed reconciliation failed:', e?.message || e);
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
        if (item) _deduplicatedOnItem(item);
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
      this._lanTimer = setInterval(() => this._lanAnnounce(), 15000);
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
      this._node.transport.handleSignal(data.from, data.signal).catch(err => {
        console.warn('[SDK Mesh] handleSignal failed:', err.message);
      });
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
   * Low-level typed send (used by ChatUI for CHAT_READ receipts, etc.)
   * @param {string} toPeerId
   * @param {object} msg — must have a `type` field
   */
  _send(toPeerId, msg) {
    if (!this._node || !msg?.type) return;
    try { this._node.sendMessage(toPeerId, msg.type, msg); } catch (_) {}
  }

  /**
   * Broadcast a new listing to all neighbours via plumtree gossip.
   * @param {object} item    — marketplace listing object
   * @param {number} [ttl=4] — gossip time-to-live
   */
  broadcastItem(item, ttl = 4) {
    if (!this._node) return;
    // SDK plumtree publish (handles dedup + lazy-push automatically).
    // Persists under item: key so MerkleSync can sync it to late-joining peers.
    // The GossipSync item:received event notifies the UI via the adapter listener.
    // NOTE: Do NOT also call broadcastMessage('LISTING_NEW') — that triggers
    // MarketplaceProtocol._onListingNew which emits a SECOND item:received for
    // the same item, causing duplicates in the receiver's Dexie DB.
    this._node.publishItem(item).catch(e =>
      console.warn('[SDK Mesh] broadcastItem failed:', e.message)
    );
  }

  /**
   * Broadcast a status update for an existing listing.
   * @param {string|number} itemId
   * @param {string} status — 'available'|'pending'|'gone'
   */
  broadcastItemUpdate(itemId, status) {
    if (!this._node) return;
    const ts = Date.now();
    // LISTING_UPDATE: for SDK peers with MarketplaceProtocol installed —
    // the handler performs LWW merge and persists under item: key.
    try { this._node.broadcastMessage('LISTING_UPDATE', {
      listing: { id: itemId, status, updatedAt: ts, from: this.peerId },
    }); } catch (_) {}
    // ITEM_UPDATE: for legacy peers using window.handleMessage (index.html switch-case).
    try { this._node.broadcastMessage('ITEM_UPDATE', {
      itemId,
      status,
      updatedAt: ts,
      from: this.peerId,
    }); } catch (_) {}
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
