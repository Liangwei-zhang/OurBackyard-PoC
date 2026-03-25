/**
 * GossipSync — Item synchronisation via gossip flooding.
 *
 * Extracted from p2p-mesh.js: broadcastItem, _handleItem, _requestSync,
 * _handleSyncReq, _handleSyncResp.
 *
 * Responsibilities:
 *   - Broadcast new/updated items to all peers with TTL-based gossip forwarding
 *   - Request full item sync when a new peer connects
 *   - Deduplicate items by sellerId:timestamp composite key
 *   - Double-check by title:sellerId before insert
 *   - Strip remote DB primary key before local insert
 *   - Delegate storage to IStorage (no direct Dexie calls)
 *
 * Events emitted:
 *   'item:new'       (item)
 *   'item:update'    (itemId, status)
 *   'sync:complete'  (peerId, itemCount)
 */

import { EventBus } from '../event-bus.js';

const SYNC_ITEM_LIMIT  = 50;
const BLOB_BATCH_LIMIT = 30;

export class GossipSync extends EventBus {
  /**
   * @param {object} opts
   * @param {import('../sync/message-router.js').MessageRouter} opts.router
   * @param {import('../storage/storage-interface.js').IStorage} opts.storage
   * @param {string}  opts.peerId       — Local peer identifier (needed for sync requests)
   * @param {number} [opts.maxTTL=4]
   * @param {number} [opts.syncWindow=604800000]  — ms to look back during sync (default 7 days)
   */
  constructor({ router, storage, peerId, maxTTL = 4, syncWindow = 7 * 24 * 3600 * 1000 }) {
    super();
    this._router     = router;
    this._storage    = storage;
    this._peerId     = peerId;
    this._maxTTL     = maxTTL;
    this._syncWindow = syncWindow;

    // Register message handlers
    router.handle('ITEM',        (from, msg) => this._handleItem(from, msg.item, msg.ttl ?? maxTTL));
    router.handle('NEW_ITEM',    (from, msg) => this._handleItem(from, msg.item, msg.ttl ?? maxTTL));
    router.handle('ITEM_UPDATE', (from, msg) => this._handleItemUpdate(from, msg));
    router.handle('SYNC_REQ',    (from, msg) => this._handleSyncReq(from, msg));
    router.handle('SYNC_RESP',   (from, msg) => this._handleSyncResp(from, msg));
    router.handle('SYNC_RESPONSE',(from, msg) => this._handleSyncResp(from, msg)); // alias
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Broadcast a new item to all connected peers (gossip with TTL).
   * @param {object} item
   */
  broadcastItem(item) {
    this._router.broadcast('ITEM', { item, ttl: this._maxTTL });
  }

  /**
   * Broadcast a status update for an existing item.
   * @param {string|number} itemId
   * @param {string} status
   */
  broadcastItemUpdate(itemId, status) {
    this._router.broadcast('ITEM_UPDATE', { itemId, status, ts: Date.now() });
  }

  /**
   * Request a full item sync from a newly-connected peer.
   * Called automatically by P2PNode on 'peer:connected'.
   * @param {string} peerId
   */
  async requestSync(peerId) {
    const since = Date.now() - this._syncWindow;
    const items = await this._storage.getItems(since, 100).catch(() => []);
    const ids   = items.map(i => `${i.sellerId || ''}:${i.timestamp || 0}`);
    this._router.send(peerId, 'SYNC_REQ', { ids, since, peerId: this._peerId });
  }

  // ─────────────────────────── Internal handlers ───────────────────────────

  async _handleItem(fromPeerId, item, ttl) {
    if (!item || (!item.title && item.id === undefined && item.itemId === undefined)) return;

    // Upsert by sellerId + timestamp
    const exists = await this._storage.hasItem(item.sellerId, item.timestamp).catch(() => false);
    if (!exists) {
      const byTitle = await this._storage.hasItemByTitle(item.sellerId, item.title || '').catch(() => false);
      if (!byTitle) {
        // Strip remote DB primary key to avoid PK conflicts
        const storeItem = { ...item, _receivedFrom: fromPeerId };
        delete storeItem.id;
        await this._storage.addItem(storeItem).catch(() => {});
        this.emit('item:new', storeItem);
      }
    }

    // Gossip forwarding with TTL decrement
    const nextTTL = (ttl ?? this._maxTTL) - 1;
    if (nextTTL > 0) {
      this._router.broadcastRaw(
        JSON.stringify({ type: 'ITEM', item: { ...item, _ttl: nextTTL }, ttl: nextTTL }),
        fromPeerId
      );
    }
  }

  async _handleItemUpdate(fromPeerId, msg) {
    if (!msg.itemId || !msg.status) return;
    await this._storage.updateItemStatus(msg.itemId, msg.status).catch(() => {});
    this.emit('item:update', msg.itemId, msg.status);
  }

  async _handleSyncReq(fromPeerId, msg) {
    const theirIds = new Set(msg.ids ?? []);
    const since    = msg.since ?? 0;
    const items    = await this._storage.getItems(since, 200).catch(() => []);

    const missing = items
      .filter(i => !theirIds.has(`${i.sellerId || ''}:${i.timestamp || 0}`))
      .slice(0, SYNC_ITEM_LIMIT)
      .map(i => {
        const copy = { ...i };
        delete copy.id;
        return copy;
      });

    if (missing.length > 0) {
      this._router.send(fromPeerId, 'SYNC_RESP', { items: missing });
    }
  }

  async _handleSyncResp(fromPeerId, msg) {
    if (!msg.items?.length) return;

    for (const item of msg.items) {
      await this._handleItem(fromPeerId, item, 0); // TTL 0 — don't re-gossip sync responses
    }

    // After receiving items, ask for blobs we're missing
    const hashSet = new Set();
    msg.items.forEach(i => {
      (i.imageHashes?.length ? i.imageHashes : (i.imageHash ? [i.imageHash] : []))
        .forEach(h => hashSet.add(h));
    });
    const hashes = [...hashSet].filter(Boolean);
    if (!hashes.length) {
      this.emit('sync:complete', fromPeerId, msg.items.length);
      return;
    }

    const missing = await this._storage.getMissingBlobHashes(hashes).catch(() => hashes);
    if (missing.length > 0) {
      const batch = missing.slice(0, BLOB_BATCH_LIMIT);
      this._router.send(fromPeerId, 'BLOB_REQ', { hashes: batch });
    }

    this.emit('sync:complete', fromPeerId, msg.items.length);
  }
}
