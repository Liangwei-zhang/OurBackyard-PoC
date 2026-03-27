import { EventBus } from '../event-bus.js';
import { uuid, sha256hex } from '../utils.js';

/**
 * Transfer priority constants.
 */
export const BlobPriority = Object.freeze({ PROFILE: 0, LISTING: 1, OTHER: 2 });

const CHUNK_SIZE = 16 * 1024; // 16 KB
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

/**
 * BlobTransfer — chunked binary blob streaming over P2P DataChannels.
 *
 * Features:
 *  - Chunked transfer (16 KB per chunk)
 *  - Transfer queue with priority (PROFILE > LISTING > OTHER)
 *  - Retry logic (3 attempts with exponential backoff)
 *  - Progress tracking per transfer
 *  - Integrity verification (SHA-256 after assembly)
 *  - Concurrent transfer limit (max 3 simultaneous)
 *  - Events: 'transfer:start', 'transfer:progress', 'transfer:complete', 'transfer:error'
 */
export class BlobTransfer extends EventBus {
  /**
   * @param {object} opts
   * @param {import('../sync/message-router.js').MessageRouter} opts.router
   * @param {string} opts.peerId - Local peer ID
   * @param {number} [opts.chunkSize=16384]
   * @param {number} [opts.maxConcurrent=3]
   * @param {number} [opts.maxRetries=3]
   */
  constructor({ router, peerId, chunkSize = CHUNK_SIZE, maxConcurrent = MAX_CONCURRENT, maxRetries = MAX_RETRIES }) {
    super();
    if (!router) throw new TypeError('router is required');
    if (!peerId) throw new TypeError('peerId is required');
    this._router = router;
    this._peerId = peerId;
    this._chunkSize = chunkSize;
    this._maxConcurrent = maxConcurrent;
    this._maxRetries = maxRetries;

    /** @type {Map<string, object>} - transferId -> transfer state */
    this._inbound = new Map();
    /** @type {Map<string, object>} - transferId -> outbound state */
    this._outbound = new Map();
    /** @type {Array<object>} - queued outbound requests sorted by priority */
    this._queue = [];
    this._active = 0;

    router.handle('BLOB_START', (from, msg) => this._onBlobStart(from, msg));
    router.handle('BLOB_CHUNK', (from, msg) => this._onBlobChunk(from, msg));
    router.handle('BLOB_END', (from, msg) => this._onBlobEnd(from, msg));
    router.handle('BLOB_ACK', (from, msg) => this._onBlobAck(from, msg));
    router.handle('BLOB_ERROR', (from, msg) => this._onBlobError(from, msg));
  }

  /**
   * Queue a blob for transfer to a peer.
   * @param {string} toPeerId
   * @param {ArrayBuffer|Uint8Array} data
   * @param {object} [meta={}] - Arbitrary metadata (filename, mimeType, etc.)
   * @param {number} [priority=BlobPriority.OTHER]
   * @returns {Promise<string>} Transfer ID
   */
  async send(toPeerId, data, meta = {}, priority = BlobPriority.OTHER) {
    if (!toPeerId) throw new TypeError('toPeerId is required');
    if (!data) throw new TypeError('data is required');

    const buf = data instanceof Uint8Array ? data.buffer : data;
    const hash = await sha256hex(new Uint8Array(buf));
    const transferId = uuid();
    const totalChunks = Math.ceil(buf.byteLength / this._chunkSize);

    const entry = { transferId, toPeerId, buf, meta, priority, hash, totalChunks, attempt: 0 };
    this._queue.push(entry);
    this._queue.sort((a, b) => a.priority - b.priority);
    this._drainQueue();
    return transferId;
  }

  /** @private */
  _drainQueue() {
    while (this._active < this._maxConcurrent && this._queue.length > 0) {
      const entry = this._queue.shift();
      this._active++;
      this._doSend(entry).finally(() => {
        this._active--;
        this._drainQueue();
      });
    }
  }

  /** @private */
  async _doSend(entry, attempt = 0) {
    const { transferId, toPeerId, buf, meta, hash, totalChunks } = entry;
    try {
      this.emit('transfer:start', { transferId, toPeerId, totalBytes: buf.byteLength, meta });

      // Send START message
      await this._send(toPeerId, {
        type: 'BLOB_START',
        id: uuid(),
        transferId,
        totalChunks,
        totalBytes: buf.byteLength,
        hash,
        meta,
      });

      // Send chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * this._chunkSize;
        const chunk = buf.slice(start, start + this._chunkSize);
        const chunkArr = Array.from(new Uint8Array(chunk));
        await this._send(toPeerId, {
          type: 'BLOB_CHUNK',
          id: uuid(),
          transferId,
          index: i,
          data: chunkArr,
        });
        const progress = (i + 1) / totalChunks;
        this.emit('transfer:progress', { transferId, toPeerId, progress });
      }

      // Register outbound state before sending END so the ACK handler can find it
      this._outbound.set(transferId, { ...entry, status: 'sent' });

      // Send END message
      await this._send(toPeerId, {
        type: 'BLOB_END',
        id: uuid(),
        transferId,
        hash,
      });
    } catch (err) {
      if (attempt < this._maxRetries - 1) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        return this._doSend(entry, attempt + 1);
      }
      this.emit('transfer:error', { transferId, toPeerId, error: err, attempt });
      throw err;
    }
  }

  /**
   * Get transfer progress for an active outbound transfer, looked up by content hash.
   * @param {string} hash - SHA-256 hex hash of the blob
   * @returns {{progress: number}|null} progress 0..1, or null if not tracking
   */
  getTransferProgress(hash) {
    for (const state of this._outbound.values()) {
      if (state.hash === hash) {
        // Outbound state is recorded after all chunks are sent (awaiting ACK), so progress ≈ 1
        return { progress: state.progress ?? 1 };
      }
    }
    return null;
  }

  /**
   * @private - route a message to a peer (delegates to router's send callback if set, or emits)
   */
  async _send(toPeerId, message) {
    // The host P2PNode should set this._sendFn
    if (typeof this._sendFn === 'function') {
      return this._sendFn(toPeerId, message);
    }
    // Fallback: emit for transport layer to pick up
    this.emit('send', toPeerId, message);
  }

  /**
   * Set the send function for outbound messages.
   * @param {Function} fn - (toPeerId, message) => Promise<void>
   */
  setSendFn(fn) {
    this._sendFn = fn;
  }

  /** @private */
  _onBlobStart(from, msg) {
    const { transferId, totalChunks, totalBytes, hash, meta } = msg;
    this._inbound.set(transferId, {
      from,
      totalChunks,
      totalBytes,
      hash,
      meta,
      chunks: new Array(totalChunks),
      received: 0,
    });
  }

  /** @private */
  _onBlobChunk(from, msg) {
    const { transferId, index, data } = msg;
    const state = this._inbound.get(transferId);
    if (!state) return;
    // Bounds check: reject out-of-range indices to prevent memory corruption
    if (typeof index !== 'number' || index < 0 || index >= state.totalChunks) return;
    state.chunks[index] = new Uint8Array(data);
    state.received++;
    const progress = state.received / state.totalChunks;
    this.emit('transfer:progress', { transferId, from, progress });
  }

  /** @private */
  async _onBlobEnd(from, msg) {
    const { transferId, hash } = msg;
    const state = this._inbound.get(transferId);
    if (!state) return;

    // Assemble
    const total = state.chunks.reduce((s, c) => s + c.length, 0);
    const assembled = new Uint8Array(total);
    let offset = 0;
    for (const chunk of state.chunks) {
      assembled.set(chunk, offset);
      offset += chunk.length;
    }

    // Verify integrity
    const actualHash = await sha256hex(assembled);
    if (actualHash !== hash) {
      this._inbound.delete(transferId);
      await this._send(from, { type: 'BLOB_ERROR', id: uuid(), transferId, reason: 'hash_mismatch' });
      this.emit('transfer:error', { transferId, from, error: new Error('Hash mismatch') });
      return;
    }

    this._inbound.delete(transferId);
    await this._send(from, { type: 'BLOB_ACK', id: uuid(), transferId });
    this.emit('transfer:complete', { transferId, from, data: assembled.buffer, meta: state.meta });
  }

  /** @private */
  _onBlobAck(from, msg) {
    const { transferId } = msg;
    const state = this._outbound.get(transferId);
    if (state) {
      this.emit('transfer:complete', { transferId, toPeerId: from, status: 'acked' });
      this._outbound.delete(transferId);
    }
  }

  /** @private */
  _onBlobError(from, msg) {
    const { transferId, reason } = msg;
    this.emit('transfer:error', { transferId, from, error: new Error(reason) });
  }
}
