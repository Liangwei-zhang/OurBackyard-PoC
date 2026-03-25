/**
 * IStorage — Storage adapter interface.
 *
 * Implement this with Dexie (IndexedDB), localStorage, or the bundled MemoryStorage.
 * All methods return Promises. Unimplemented methods throw to aid development.
 *
 * The SDK never touches storage directly — it always goes through this interface.
 */
export class IStorage {
  // ─────────────────────────── Items ───────────────────────────

  /**
   * Return items created/updated since `since` (epoch ms), newest first.
   * @param {number} since   — epoch ms lower bound
   * @param {number} [limit=100]
   * @returns {Promise<object[]>}
   */
  async getItems(since, limit = 100) { throw new Error('IStorage.getItems() not implemented'); }

  /**
   * Persist a new item.
   * @param {object} item
   * @returns {Promise<void>}
   */
  async addItem(item) { throw new Error('IStorage.addItem() not implemented'); }

  /**
   * Check if an item with the given sellerId + timestamp already exists.
   * @param {string} sellerId
   * @param {number} timestamp
   * @returns {Promise<boolean>}
   */
  async hasItem(sellerId, timestamp) { throw new Error('IStorage.hasItem() not implemented'); }

  /**
   * Check if an item with the given sellerId + title already exists.
   * @param {string} sellerId
   * @param {string} title
   * @returns {Promise<boolean>}
   */
  async hasItemByTitle(sellerId, title) { throw new Error('IStorage.hasItemByTitle() not implemented'); }

  /**
   * Update the status of an item.
   * @param {string|number} itemId
   * @param {string} status
   * @returns {Promise<void>}
   */
  async updateItemStatus(itemId, status) { throw new Error('IStorage.updateItemStatus() not implemented'); }

  // ─────────────────────────── Blobs ───────────────────────────

  /**
   * Retrieve a blob record by hash.
   * @param {string} hash
   * @returns {Promise<{hash:string, blob:Blob, itemId?:string}|null>}
   */
  async getBlob(hash) { throw new Error('IStorage.getBlob() not implemented'); }

  /**
   * Persist a blob.
   * @param {string} hash
   * @param {Blob}   blob
   * @param {object} [meta]   — optional { itemId, ... }
   * @returns {Promise<void>}
   */
  async addBlob(hash, blob, meta) { throw new Error('IStorage.addBlob() not implemented'); }

  /**
   * Check whether a blob with the given hash exists locally.
   * @param {string} hash
   * @returns {Promise<boolean>}
   */
  async hasBlob(hash) { throw new Error('IStorage.hasBlob() not implemented'); }

  /**
   * Given a list of hashes, return the subset that we don't have locally.
   * @param {string[]} hashes
   * @returns {Promise<string[]>}
   */
  async getMissingBlobHashes(hashes) { throw new Error('IStorage.getMissingBlobHashes() not implemented'); }

  // ─────────────────────────── Chat messages ───────────────────────────

  /**
   * Persist an incoming or outgoing chat message.
   * @param {object} msg
   * @returns {Promise<void>}
   */
  async addChatMessage(msg) { throw new Error('IStorage.addChatMessage() not implemented'); }

  /**
   * Retrieve a chat message by its unique id.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getChatMessage(id) { throw new Error('IStorage.getChatMessage() not implemented'); }

  /**
   * Mark a chat message as read.
   * @param {string} msgId
   * @param {number} readAt — epoch ms
   * @returns {Promise<void>}
   */
  async markRead(msgId, readAt) { throw new Error('IStorage.markRead() not implemented'); }

  // ─────────────────────────── Dead Drop (offline messages) ───────────────────────────

  /**
   * Queue an offline message for delivery when the peer reconnects.
   * @param {string} toPeerId
   * @param {object} msg
   * @returns {Promise<string>} — record id
   */
  async addDeadDrop(toPeerId, msg) { throw new Error('IStorage.addDeadDrop() not implemented'); }

  /**
   * Return all undelivered dead-drop records for the given peer.
   * @param {string} toPeerId
   * @returns {Promise<object[]>}
   */
  async getPendingDeadDrop(toPeerId) { throw new Error('IStorage.getPendingDeadDrop() not implemented'); }

  /**
   * Mark a dead-drop record as delivered.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async markDelivered(id) { throw new Error('IStorage.markDelivered() not implemented'); }

  // ─────────────────────────── CRDT ───────────────────────────

  /**
   * Retrieve serialized CRDT state for a document.
   * @param {string} docId
   * @returns {Promise<{ type: string, state: object }|null>}
   */
  async getCRDTState(docId) { throw new Error('IStorage.getCRDTState() not implemented'); }

  /**
   * Persist serialized CRDT state for a document.
   * @param {string} docId
   * @param {string} type   — CRDT type identifier ('lww-register', 'g-counter', 'or-set')
   * @param {object} state  — Serialized state from crdt.toJSON()
   * @returns {Promise<void>}
   */
  async setCRDTState(docId, type, state) { throw new Error('IStorage.setCRDTState() not implemented'); }

  /**
   * Return all stored CRDT documents.
   * @returns {Promise<Array<{ docId: string, type: string, state: object }>>}
   */
  async getAllCRDTDocs() { throw new Error('IStorage.getAllCRDTDocs() not implemented'); }
}
