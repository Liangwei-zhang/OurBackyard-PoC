/**
 * BlobTransfer — Chunked binary blob streaming over WebRTC DataChannels.
 *
 * Extracted from p2p-mesh.js: _handleBlobReq, _handleBlobStreamStart,
 * _routeBinaryChunk, _handleBlobStreamEnd.
 *
 * Protocol framing:
 *   BLOB_STREAM_START (JSON) → binary chunks → BLOB_STREAM_END (JSON)
 *
 * Enhancements over original:
 *   - Retry logic for failed chunk transfers (up to maxRetries)
 *   - Integrity verification (SHA-256 of received data vs expected hash)
 *   - Transfer queue to prevent overwhelming DataChannels
 *   - Progress events with ETA calculation
 *   - Transfer cancellation support
 *
 * Events emitted:
 *   'blob:received'   (hash, blob)
 *   'blob:progress'   (hash, { received, total, percent, bytesPerSec, etaSec })
 *   'blob:error'      (hash, error)
 *   'blob:cancelled'  (hash)
 */

import { EventBus } from '../event-bus.js';
import { sha256hex } from '../utils.js';

const BLOB_BATCH_LIMIT = 30;

export class BlobTransfer extends EventBus {
  /**
   * @param {object} opts
   * @param {import('../sync/message-router.js').MessageRouter} opts.router
   * @param {import('../storage/storage-interface.js').IStorage} opts.storage
   * @param {number} [opts.chunkSize=65536]
   * @param {number} [opts.maxBuffer=4194304]
   * @param {number} [opts.maxRetries=3]      — retries per blob transfer
   * @param {number} [opts.queueConcurrency=2] — max parallel outgoing transfers
   */
  constructor({ router, storage, chunkSize = 65536, maxBuffer = 4194304, maxRetries = 3, queueConcurrency = 2 }) {
    super();
    this._router          = router;
    this._storage         = storage;
    this._chunkSize       = chunkSize;
    this._maxBuffer       = maxBuffer;
    this._maxRetries      = maxRetries;
    this._queueConcurrency = queueConcurrency;

    /** @type {Map<string, object>} key: "peerId:hash" → stream state */
    this._streams = new Map();

    /**
     * Outgoing transfer queue entries: { peerId, hash, blob, meta, retries }
     * @type {Array<object>}
     */
    this._sendQueue = [];
    /** @type {number} currently active outgoing transfers */
    this._activeSends = 0;

    /**
     * Cancellation tokens: hash → true
     * @type {Set<string>}
     */
    this._cancelled = new Set();

    // Register message handlers
    router.handle('BLOB_REQ',          (from, msg) => this._handleBlobReq(from, msg));
    router.handle('BLOB_STREAM_START', (from, msg) => this._handleBlobStreamStart(from, msg));
    router.handle('BLOB_STREAM_END',   (from, msg) => this._handleBlobStreamEnd(from, msg));
    // Legacy base64 fallback
    router.handle('BLOB_RESP',         (from, msg) => this._handleBlobResp(from, msg));
    // Binary frames
    router.handle('binary',            (from, ab)  => this._routeBinaryChunk(from, ab));
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Request specific blobs from a peer by hash list.
   * @param {string}   peerId
   * @param {string[]} hashes
   */
  requestBlobs(peerId, hashes) {
    if (!hashes?.length) return;
    const batch = hashes.slice(0, BLOB_BATCH_LIMIT);
    this._router.send(peerId, 'BLOB_REQ', { hashes: batch });
  }

  /**
   * Enqueue a blob for sending to a peer.
   * The actual transfer is queued to limit DataChannel congestion.
   * @param {string} peerId
   * @param {string} hash
   * @param {Blob}   blob
   * @param {object} [meta]   — optional { itemId, mime }
   */
  sendBlob(peerId, hash, blob, meta = {}) {
    if (this._cancelled.has(hash)) return;
    this._sendQueue.push({ peerId, hash, blob, meta, retries: 0 });
    this._drainQueue();
  }

  /**
   * Cancel an in-progress or queued transfer by hash.
   * @param {string} hash
   */
  cancel(hash) {
    this._cancelled.add(hash);
    // Remove from queue
    this._sendQueue = this._sendQueue.filter(e => e.hash !== hash);
    // Mark any active receive stream as cancelled
    for (const [key, state] of this._streams) {
      if (state.hash === hash) {
        this._streams.delete(key);
        this.emit('blob:cancelled', hash);
      }
    }
  }

  // ─────────────────────────── Queue / Send ───────────────────────────

  _drainQueue() {
    while (this._activeSends < this._queueConcurrency && this._sendQueue.length > 0) {
      const entry = this._sendQueue.shift();
      if (entry && !this._cancelled.has(entry.hash)) {
        this._activeSends++;
        this._doSend(entry).finally(() => {
          this._activeSends--;
          this._drainQueue();
        });
      }
    }
  }

  async _doSend(entry) {
    const { peerId, hash, blob, meta } = entry;
    if (this._cancelled.has(hash)) return;

    const dc = this._router._transport?.getDataChannel?.(peerId);
    if (!dc) return;

    const ab    = await blob.arrayBuffer();
    const mime  = blob.type || meta.mime || 'application/octet-stream';
    const total = Math.ceil(ab.byteLength / this._chunkSize);

    try {
      dc.send(JSON.stringify({
        type: 'BLOB_STREAM_START',
        hash, mime, total,
        size:   ab.byteLength,
        itemId: meta.itemId,
      }));

      const startTime = Date.now();

      for (let i = 0; i < total; i++) {
        if (this._cancelled.has(hash)) {
          this.emit('blob:cancelled', hash);
          return;
        }

        // Backpressure control
        while (dc.bufferedAmount > this._maxBuffer) {
          await new Promise(r => {
            dc.onbufferedamountlow = r;
            setTimeout(r, 100);
          });
        }
        if (dc.readyState !== 'open') throw new Error('DataChannel closed during transfer');

        dc.send(ab.slice(i * this._chunkSize, (i + 1) * this._chunkSize));

        // Progress + ETA
        const elapsed = (Date.now() - startTime) / 1000;
        const bytesDone = Math.min((i + 1) * this._chunkSize, ab.byteLength);
        const bytesPerSec = elapsed > 0 ? bytesDone / elapsed : 0;
        const remaining = ab.byteLength - bytesDone;
        const etaSec = bytesPerSec > 0 ? remaining / bytesPerSec : Infinity;
        const percent = Math.round(((i + 1) / total) * 100);

        this.emit('blob:progress', hash, {
          received: i + 1,
          total,
          percent,
          bytesPerSec: Math.round(bytesPerSec),
          etaSec: isFinite(etaSec) ? Math.round(etaSec) : null,
          direction: 'send',
        });
      }

      dc.send(JSON.stringify({ type: 'BLOB_STREAM_END', hash }));
    } catch (e) {
      console.warn('[BlobTransfer] sendBlob error:', e.message);

      // Retry logic
      if (entry.retries < this._maxRetries && !this._cancelled.has(hash)) {
        entry.retries++;
        const delay = Math.pow(2, entry.retries) * 200; // exponential back-off
        await new Promise(r => setTimeout(r, delay));
        this._sendQueue.unshift(entry); // re-queue at front
      } else {
        this.emit('blob:error', hash, e);
      }
    }
  }

  // ─────────────────────────── Internal handlers ───────────────────────────

  async _handleBlobReq(fromPeerId, msg) {
    if (!msg.hashes?.length) return;
    const hashes = msg.hashes.slice(0, BLOB_BATCH_LIMIT);

    for (const hash of hashes) {
      const blobRecord = await this._storage.getBlob(hash).catch(() => null);
      if (!blobRecord) continue;
      this.sendBlob(fromPeerId, hash, blobRecord.blob, { itemId: blobRecord.itemId });
      // Small yield between enqueues
      await new Promise(r => setTimeout(r, 0));
    }
  }

  _handleBlobStreamStart(fromPeerId, msg) {
    if (!msg.hash) return;
    this._streams.set(`${fromPeerId}:${msg.hash}`, {
      hash:      msg.hash,
      mime:      msg.mime || 'application/octet-stream',
      itemId:    msg.itemId,
      total:     msg.total,
      size:      msg.size,
      chunks:    [],
      received:  0,
      startTime: Date.now(),
    });
  }

  _routeBinaryChunk(fromPeerId, ab) {
    for (const [key, state] of this._streams) {
      if (key.startsWith(`${fromPeerId}:`) && state.received < state.total) {
        if (this._cancelled.has(state.hash)) {
          this._streams.delete(key);
          return;
        }

        state.chunks.push(ab);
        state.received++;

        // Progress + ETA for receive
        const elapsed = (Date.now() - state.startTime) / 1000;
        const bytesDone = state.chunks.reduce((s, c) => s + c.byteLength, 0);
        const bytesPerSec = elapsed > 0 ? bytesDone / elapsed : 0;
        const remaining = (state.size || 0) - bytesDone;
        const etaSec = bytesPerSec > 0 ? remaining / bytesPerSec : Infinity;
        const percent = Math.round((state.received / state.total) * 100);

        this.emit('blob:progress', state.hash, {
          received: state.received,
          total: state.total,
          percent,
          bytesPerSec: Math.round(bytesPerSec),
          etaSec: isFinite(etaSec) ? Math.round(etaSec) : null,
          direction: 'receive',
        });
        return;
      }
    }
  }

  async _handleBlobStreamEnd(fromPeerId, msg) {
    const key   = `${fromPeerId}:${msg.hash}`;
    const state = this._streams.get(key);
    if (!state) return;
    this._streams.delete(key);

    if (this._cancelled.has(state.hash)) {
      this.emit('blob:cancelled', state.hash);
      return;
    }

    try {
      const blob = new Blob(state.chunks, { type: state.mime });

      // Integrity verification: compare SHA-256 of received data with expected hash
      const ab = await blob.arrayBuffer();
      const receivedHex = await sha256hex(
        Array.from(new Uint8Array(ab)).map(b => String.fromCharCode(b)).join('')
      ).catch(() => null);

      if (receivedHex && receivedHex !== state.hash) {
        const err = new Error(
          `BlobTransfer: integrity check failed for ${state.hash} (received ${receivedHex})`
        );
        console.warn('[BlobTransfer]', err.message);
        this.emit('blob:error', state.hash, err);
        return;
      }

      const exists = await this._storage.hasBlob(state.hash).catch(() => false);
      if (!exists) {
        await this._storage.addBlob(state.hash, blob, { itemId: state.itemId }).catch(() => {});
      }
      this.emit('blob:received', state.hash, blob);
    } catch (e) {
      console.warn('[BlobTransfer] stream assembly error:', e.message);
      this.emit('blob:error', state.hash, e);
    }
  }

  /** Legacy base64 BLOB_RESP (backward compatibility with older nodes) */
  async _handleBlobResp(fromPeerId, msg) {
    if (!msg.hash || !msg.data) return;
    try {
      const b64 = msg.data.replace(/[^A-Za-z0-9+/=]/g, '');
      const raw = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      const blob = new Blob([raw], { type: msg.mime || 'image/jpeg' });
      const exists = await this._storage.hasBlob(msg.hash).catch(() => false);
      if (!exists) {
        await this._storage.addBlob(msg.hash, blob, { itemId: msg.itemId }).catch(() => {});
      }
      this.emit('blob:received', msg.hash, blob);
    } catch (e) {
      console.warn('[BlobTransfer] legacy BLOB_RESP decode error:', e.message);
    }
  }
}
