/**
 * DexieStorage — Production IndexedDB storage adapter using Dexie.js.
 *
 * Implements the full IStorage interface backed by IndexedDB.
 * Requires Dexie v3+ to be available (import or CDN).
 *
 * Schema:
 *   items:        ++_localId, sellerId, timestamp, title, status, [sellerId+timestamp]
 *   blobs:        hash, blob, itemId, timestamp
 *   chatMessages: id, from, to, text, timestamp, read, readAt
 *   deadDrops:    ++id, toPeerId, msg, createdAt, delivered, deliveredAt
 *   crdt:         docId, type, state, updatedAt
 *
 * Usage:
 *   import Dexie from 'dexie';
 *   const storage = new DexieStorage('my-app', Dexie);
 *   await storage.open();
 */

import { IStorage } from './storage-interface.js';
import { uuid } from '../utils.js';

export class DexieStorage extends IStorage {
  /**
   * @param {string} [dbName='p2p-sdk']
   * @param {Function} DexieClass — Dexie constructor (injected to avoid hard dep)
   */
  constructor(dbName = 'p2p-sdk', DexieClass) {
    super();
    if (!DexieClass) throw new Error('DexieStorage: Dexie constructor must be provided as second argument');
    this._db = new DexieClass(dbName);

    this._db.version(1).stores({
      items:        '++_localId, sellerId, timestamp, title, status, [sellerId+timestamp]',
      blobs:        'hash, itemId, timestamp',
      chatMessages: 'id, from, to, timestamp, read',
      deadDrops:    '++id, toPeerId, delivered, createdAt',
      crdt:         'docId, type, updatedAt',
    });
  }

  /**
   * Open the database (call once before using storage).
   * @returns {Promise<void>}
   */
  async open() {
    await this._db.open();
  }

  // ─────────────────────────── Items ───────────────────────────

  async getItems(since, limit = 100) {
    return this._db.items
      .where('timestamp').aboveOrEqual(since)
      .reverse()
      .limit(limit)
      .toArray();
  }

  async addItem(item) {
    const stored = { ...item, _localId: item._localId || uuid() };
    delete stored.id; // Remove remote PKs
    await this._db.items.put(stored);
  }

  async hasItem(sellerId, timestamp) {
    const count = await this._db.items
      .where('[sellerId+timestamp]')
      .equals([sellerId || '', timestamp || 0])
      .count();
    return count > 0;
  }

  async hasItemByTitle(sellerId, title) {
    const count = await this._db.items
      .where({ sellerId, title })
      .count();
    return count > 0;
  }

  async updateItemStatus(itemId, status) {
    // itemId may be _localId or a custom field
    const item = await this._db.items.get(itemId);
    if (item) {
      await this._db.items.update(itemId, { status });
    }
  }

  // ─────────────────────────── Blobs ───────────────────────────

  async getBlob(hash) {
    return (await this._db.blobs.get(hash)) ?? null;
  }

  async addBlob(hash, blob, meta = {}) {
    const exists = await this.hasBlob(hash);
    if (!exists) {
      await this._db.blobs.put({ hash, blob, ...meta, timestamp: Date.now() });
    }
  }

  async hasBlob(hash) {
    return (await this._db.blobs.get(hash)) !== undefined;
  }

  async getMissingBlobHashes(hashes) {
    const existing = await this._db.blobs
      .where('hash').anyOf(hashes)
      .primaryKeys();
    const existingSet = new Set(existing);
    return hashes.filter(h => !existingSet.has(h));
  }

  // ─────────────────────────── Chat messages ───────────────────────────

  async addChatMessage(msg) {
    await this._db.chatMessages.put({ ...msg });
  }

  async getChatMessage(id) {
    return (await this._db.chatMessages.get(id)) ?? null;
  }

  async markRead(msgId, readAt) {
    await this._db.chatMessages.update(msgId, { read: true, readAt });
  }

  // ─────────────────────────── Dead Drop ───────────────────────────

  async addDeadDrop(toPeerId, msg) {
    const id = await this._db.deadDrops.add({
      toPeerId,
      msg,
      createdAt: Date.now(),
      delivered: false,
    });
    return String(id);
  }

  async getPendingDeadDrop(toPeerId) {
    return this._db.deadDrops
      .where({ toPeerId, delivered: 0 })
      .toArray();
  }

  async markDelivered(id) {
    await this._db.deadDrops.update(Number(id), {
      delivered: true,
      deliveredAt: Date.now(),
    });
  }

  // ─────────────────────────── CRDT ───────────────────────────

  async getCRDTState(docId) {
    return (await this._db.crdt.get(docId)) ?? null;
  }

  async setCRDTState(docId, type, state) {
    await this._db.crdt.put({ docId, type, state, updatedAt: Date.now() });
  }

  async getAllCRDTDocs() {
    return this._db.crdt.toArray();
  }
}
