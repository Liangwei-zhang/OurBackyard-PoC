/**
 * MemoryStorage — In-memory IStorage implementation for testing and quick prototyping.
 *
 * Uses plain Maps — no external dependencies, no persistence across page reloads.
 * Drop-in replacement for the Dexie adapter during development and unit tests.
 */

import { IStorage } from './storage-interface.js';
import { uuid } from '../utils.js';

export class MemoryStorage extends IStorage {
  constructor() {
    super();
    /** @type {Map<string, object>}  composite key "sellerId:timestamp" → item */
    this._items        = new Map();
    /** @type {Map<string, object>}  hash → { hash, blob, itemId, timestamp } */
    this._blobs        = new Map();
    /** @type {Map<string, object>}  id → msg */
    this._chatMessages = new Map();
    /** @type {Map<string, object>}  id → record */
    this._deadDrops    = new Map();
  }

  // ─────────────────────────── Items ───────────────────────────

  async getItems(since, limit = 100) {
    return [...this._items.values()]
      .filter(i => (i.timestamp || 0) >= since)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);
  }

  async addItem(item) {
    const key = `${item.sellerId || ''}:${item.timestamp || 0}`;
    // Assign a local id if the item doesn't have one
    const stored = { ...item, _localId: item._localId || uuid() };
    this._items.set(key, stored);
  }

  async hasItem(sellerId, timestamp) {
    return this._items.has(`${sellerId || ''}:${timestamp || 0}`);
  }

  async hasItemByTitle(sellerId, title) {
    for (const item of this._items.values()) {
      if (item.sellerId === sellerId && item.title === title) return true;
    }
    return false;
  }

  async updateItemStatus(itemId, status) {
    for (const [key, item] of this._items) {
      if (item._localId === itemId || item.itemId === itemId) {
        this._items.set(key, { ...item, status });
        return;
      }
    }
  }

  // ─────────────────────────── Blobs ───────────────────────────

  async getBlob(hash) {
    return this._blobs.get(hash) ?? null;
  }

  async addBlob(hash, blob, meta = {}) {
    if (!this._blobs.has(hash)) {
      this._blobs.set(hash, { hash, blob, ...meta, timestamp: Date.now() });
    }
  }

  async hasBlob(hash) {
    return this._blobs.has(hash);
  }

  async getMissingBlobHashes(hashes) {
    return hashes.filter(h => !this._blobs.has(h));
  }

  // ─────────────────────────── Chat messages ───────────────────────────

  async addChatMessage(msg) {
    this._chatMessages.set(msg.id, { ...msg });
  }

  async getChatMessage(id) {
    return this._chatMessages.get(id) ?? null;
  }

  async markRead(msgId, readAt) {
    const msg = this._chatMessages.get(msgId);
    if (msg) this._chatMessages.set(msgId, { ...msg, read: true, readAt });
  }

  // ─────────────────────────── Dead Drop ───────────────────────────

  async addDeadDrop(toPeerId, msg) {
    const id = uuid();
    this._deadDrops.set(id, { id, toPeerId, msg, createdAt: Date.now(), delivered: false });
    return id;
  }

  async getPendingDeadDrop(toPeerId) {
    return [...this._deadDrops.values()].filter(r => r.toPeerId === toPeerId && !r.delivered);
  }

  async markDelivered(id) {
    const record = this._deadDrops.get(id);
    if (record) this._deadDrops.set(id, { ...record, delivered: true, deliveredAt: Date.now() });
  }

  // ─────────────────────────── CRDT ───────────────────────────

  async getCRDTState(docId) {
    return this._crdt?.get(docId) ?? null;
  }

  async setCRDTState(docId, type, state) {
    if (!this._crdt) this._crdt = new Map();
    this._crdt.set(docId, { docId, type, state, updatedAt: Date.now() });
  }

  async getAllCRDTDocs() {
    if (!this._crdt) return [];
    return [...this._crdt.values()];
  }
}
