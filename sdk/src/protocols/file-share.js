import { uuid, sha256hex } from '../utils.js';

/**
 * FileShareProtocol — P2P file sharing plugin for P2PNode.
 *
 * Features:
 *  - Hash-based file integrity verification (SHA-256)
 *  - Offer/accept/reject handshake before transfer
 *  - Delegates actual binary transfer to BlobTransfer
 *  - Progress tracking
 *
 * Install as a plugin: `node.use(new FileShareProtocol(node))`
 *
 * Message types handled: FILE_OFFER, FILE_ACCEPT, FILE_REJECT
 */
export class FileShareProtocol {
  /**
   * @param {import('../p2p-node.js').P2PNode} p2pNode
   */
  constructor(p2pNode) {
    this._node    = p2pNode;
    this._storage = p2pNode._config?.storage || null;
    /** @type {Map<string, object>} offerId → offer */
    this._pendingOffers = new Map();
  }

  // ── Plugin interface ──────────────────────────────────────────────────────

  /**
   * Install the protocol into a P2PNode.
   * @param {import('../p2p-node.js').P2PNode} node
   */
  install(node) {
    this._node    = node;
    this._storage = node._config?.storage || null;

    node.router.handle('FILE_OFFER',  (from, msg) => this._onFileOffer(from, msg));
    node.router.handle('FILE_ACCEPT', (from, msg) => this._onFileAccept(from, msg));
    node.router.handle('FILE_REJECT', (from, msg) => this._onFileReject(from, msg));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Offer a file to a peer.
   * Sends a FILE_OFFER message; the peer must call acceptFile() to initiate transfer.
   * @param {string} toPeerId
   * @param {ArrayBuffer|Uint8Array} data - File contents
   * @param {object} [meta={}] - { name, mimeType, size, ... }
   * @returns {Promise<object>} Offer object { offerId, hash, meta }
   */
  async offerFile(toPeerId, data, meta = {}) {
    if (!toPeerId) throw new TypeError('toPeerId is required');
    if (!data)     throw new TypeError('data is required');

    const buf  = data instanceof Uint8Array ? data.buffer : data;
    const hash = await sha256hex(new Uint8Array(buf));
    const offer = {
      offerId:    uuid(),
      fromId:     this._node._config.peerId,
      toId:       toPeerId,
      hash,
      size:       buf.byteLength,
      meta:       { ...meta },
      createdAt:  Date.now(),
      status:     'pending',
    };

    // Cache the data locally so we can send when accepted
    this._pendingOffers.set(offer.offerId, { offer, data: buf });

    this._node.sendMessage(toPeerId, 'FILE_OFFER', { type: 'FILE_OFFER', id: uuid(), ...offer });
    return offer;
  }

  /**
   * Accept a file offer and initiate blob transfer.
   * @param {string} offerId
   * @returns {Promise<string>} Transfer ID
   */
  async acceptFile(offerId) {
    if (!offerId) throw new TypeError('offerId is required');
    const entry = this._pendingOffers.get(offerId);
    if (!entry) throw new Error(`No pending offer found for offerId: ${offerId}`);

    const { offer, data } = entry;
    this._node.sendMessage(offer.fromId, 'FILE_ACCEPT', { type: 'FILE_ACCEPT', id: uuid(), offerId });

    // Initiate blob transfer
    const transferId = await this._node.blobTransfer.send(offer.fromId, data, offer.meta);
    return transferId;
  }

  /**
   * Reject a file offer.
   * @param {string} offerId
   * @returns {Promise<void>}
   */
  async rejectFile(offerId) {
    if (!offerId) throw new TypeError('offerId is required');
    const entry = this._pendingOffers.get(offerId);
    if (!entry) return;

    const { offer } = entry;
    this._pendingOffers.delete(offerId);
    this._node.sendMessage(offer.fromId, 'FILE_REJECT', { type: 'FILE_REJECT', id: uuid(), offerId });
  }

  /**
   * Get transfer progress for a blob hash.
   * @param {string} hash - SHA-256 hash of the file
   * @returns {{progress: number}|null} progress 0..1, or null if not found
   */
  getTransferProgress(hash) {
    if (!this._node.blobTransfer) return null;
    return this._node.blobTransfer.getTransferProgress(hash);
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  /** @private */
  _onFileOffer(from, msg) {
    const { offerId, hash, size, meta } = msg;
    if (!offerId) return;
    // Store as pending (receiver side — no data yet)
    this._pendingOffers.set(offerId, {
      offer: { offerId, fromId: from, hash, size, meta, status: 'received' },
      data:  null, // will arrive via BlobTransfer
    });
  }

  /** @private */
  async _onFileAccept(from, msg) {
    const { offerId } = msg;
    if (!offerId) return;
    const entry = this._pendingOffers.get(offerId);
    if (!entry || !entry.data) return;

    // Initiate actual blob transfer
    try {
      await this._node.blobTransfer.send(from, entry.data, entry.offer.meta);
      this._pendingOffers.delete(offerId);
    } catch {
      // transfer error handled by BlobTransfer events
    }
  }

  /** @private */
  _onFileReject(from, msg) {
    const { offerId } = msg;
    if (offerId) this._pendingOffers.delete(offerId);
  }
}
