import { EventBus } from '../event-bus.js';
import { uuid } from '../utils.js';
import { PlumtreeGossip } from './plumtree-gossip.js';
import { MerkleSync } from './merkle-sync.js';
import { LWWRegister, ORSet, GCounter, CRDTManager } from './crdt.js';

/**
 * GossipSync — high-level P2P data synchronization layer.
 *
 * Integrates:
 *  - PlumtreeGossip for bandwidth-efficient item broadcast
 *  - MerkleSync for state reconciliation when peers rejoin
 *  - LWWRegister for item status updates (sold, reserved, etc.)
 *  - ORSet for user favorites/bookmarks
 *  - GCounter for view counts and likes
 *
 * Events: 'item:received', 'item:updated', 'sync:completed', 'peer:added', 'peer:removed'
 */
export class GossipSync extends EventBus {
  /**
   * @param {object} opts
   * @param {import('./message-router.js').MessageRouter} opts.router
   * @param {import('../storage/storage-interface.js').IStorage} opts.storage
   * @param {string} opts.peerId
   * @param {number} [opts.fanout=3]
   * @param {number} [opts.syncIntervalMs=30000]
   * @param {number} [opts.ttl=10]
   */
  constructor({ router, storage, peerId, fanout = 3, syncIntervalMs = 30000, ttl = 10 }) {
    super();
    if (!router) throw new TypeError('router is required');
    if (!storage) throw new TypeError('storage is required');
    if (!peerId) throw new TypeError('peerId is required');

    this._router = router;
    this._storage = storage;
    this._peerId = peerId;
    this._ttl = ttl;

    // Sub-components
    this._plumtree = new PlumtreeGossip({ router, peerId, fanout });
    this._merkle = new MerkleSync({ router, storage, peerId, syncIntervalMs });
    this._crdtManager = new CRDTManager({ router, peerId });

    // Forward plumtree messages to application
    this._plumtree.on('message:received', ({ topic, payload, from, msgId }) => {
      if (topic === 'item') {
        this._handleItemMessage(payload, from).catch(() => {});
      }
      this.emit('item:received', { topic, payload, from, msgId });
    });

    // Forward sync completions
    this._merkle.on('sync:completed', (data) => this.emit('sync:completed', data));

    // Forward items received via Merkle reconciliation as item:received
    // so the application layer (Dexie / UI) gets updated for pre-existing items.
    this._merkle.on('items:synced', ({ from, items }) => {
      for (const { key, value } of items) {
        if (key.startsWith('item:') && value && value.id) {
          this.emit('item:received', { topic: 'item', payload: value, from, msgId: null });
        }
      }
    });
  }

  // ── Peer management ──────────────────────────────────────────────────────────

  /**
   * Add a peer to the gossip network.
   * @param {string} peerId
   */
  addPeer(peerId) {
    if (!peerId || peerId === this._peerId) return;
    this._plumtree.addPeer(peerId);
    this.emit('peer:added', { peerId });
  }

  /**
   * Remove a peer from the gossip network.
   * @param {string} peerId
   */
  removePeer(peerId) {
    this._plumtree.removePeer(peerId);
    this.emit('peer:removed', { peerId });
  }

  // ── Item publishing ──────────────────────────────────────────────────────────

  /**
   * Publish a marketplace item to the P2P network.
   * @param {object} item - { id, title, price, status, ... }
   * @returns {Promise<string>} Message ID
   */
  async publishItem(item) {
    if (!item || !item.id) throw new TypeError('item must have an id');
    await this._storage.put(`item:${item.id}`, item);
    return this._plumtree.publish('item', item);
  }

  /**
   * Update item status using LWW-Register (e.g., sold, reserved, available).
   * @param {string} itemId
   * @param {string} status
   * @returns {Promise<void>}
   */
  async updateItemStatus(itemId, status) {
    if (!itemId) throw new TypeError('itemId is required');
    const reg = this._crdtManager.lwwRegister(`item:status:${itemId}`);
    reg.set(status);
    const item = await this._storage.get(`item:${itemId}`);
    if (item) {
      item.status = status;
      item.statusTimestamp = reg.timestamp;
      await this._storage.put(`item:${itemId}`, item);
    }
    // Broadcast via plumtree
    this._plumtree.publish('item:status', { itemId, status, timestamp: reg.timestamp, writerId: this._peerId });
    this.emit('item:updated', { itemId, status });
  }

  // ── Favorites (ORSet) ─────────────────────────────────────────────────────

  /**
   * Add an item to user favorites.
   * @param {string} userId
   * @param {string} itemId
   */
  addFavorite(userId, itemId) {
    if (!userId || !itemId) throw new TypeError('userId and itemId are required');
    const favorites = this._crdtManager.orSet(`favorites:${userId}`);
    favorites.add(itemId);
    return this;
  }

  /**
   * Remove an item from user favorites.
   * @param {string} userId
   * @param {string} itemId
   */
  removeFavorite(userId, itemId) {
    if (!userId || !itemId) throw new TypeError('userId and itemId are required');
    const favorites = this._crdtManager.orSet(`favorites:${userId}`);
    favorites.remove(itemId);
    return this;
  }

  /**
   * Get user favorites.
   * @param {string} userId
   * @returns {string[]}
   */
  getFavorites(userId) {
    const favorites = this._crdtManager.orSet(`favorites:${userId}`);
    return favorites.values();
  }

  // ── View counts (GCounter) ────────────────────────────────────────────────

  /**
   * Record a view for an item.
   * @param {string} itemId
   * @param {number} [amount=1]
   */
  recordView(itemId, amount = 1) {
    if (!itemId) throw new TypeError('itemId is required');
    const counter = this._crdtManager.gCounter(`views:${itemId}`);
    counter.increment(amount);
    return this;
  }

  /**
   * Get view count for an item.
   * @param {string} itemId
   * @returns {number}
   */
  getViewCount(itemId) {
    const counter = this._crdtManager.gCounter(`views:${itemId}`);
    return counter.value;
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  /**
   * Trigger immediate sync with a peer.
   * @param {string} peerId
   * @returns {Promise<{synced: boolean, itemsSynced: number}>}
   */
  async syncWithPeer(peerId) {
    return this._merkle.syncWithPeer(peerId);
  }

  /**
   * Start periodic background sync.
   * @param {Function} getPeers - () => string[]
   */
  startSync(getPeers) {
    this._merkle.startPeriodicSync(getPeers);
  }

  /** Stop periodic sync. */
  stopSync() {
    this._merkle.stopPeriodicSync();
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  /**
   * Set the send function for outbound messages (shared across all sub-components).
   * @param {Function} fn - (toPeerId, message) => void|Promise<void>
   */
  setSendFn(fn) {
    this._plumtree.setSendFn(fn);
    this._merkle.setSendFn(fn);
    this._crdtManager.setSendFn(fn);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** @private */
  async _handleItemMessage(item, from) {
    if (!item || !item.id) return;
    try {
      const existing = await this._storage.get(`item:${item.id}`);
      // Last-write-wins: newer updatedAt wins; tie-break by writerId (lexicographically larger wins)
      const itemTs = item.updatedAt || 0;
      const existingTs = existing ? (existing.updatedAt || 0) : -1;
      const wins = !existing ||
        itemTs > existingTs ||
        (itemTs === existingTs && (item.writerId || '') > (existing.writerId || ''));
      if (wins) {
        await this._storage.put(`item:${item.id}`, item);
      }
    } catch (e) {
      // swallow storage errors
    }
  }

  /** Clean up all resources. */
  destroy() {
    this._plumtree.destroy();
    this._merkle.destroy();
  }
}
