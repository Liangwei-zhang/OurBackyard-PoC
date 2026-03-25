/**
 * BlobTransfer — Chunked binary blob streaming over WebRTC DataChannels.
 *
 * Extracted from p2p-mesh.js: _handleBlobReq, _handleBlobStreamStart,
 * _routeBinaryChunk, _handleBlobStreamEnd.
 *
 * Protocol framing:
 *   BLOB_STREAM_START (JSON) → binary chunks → BLOB_STREAM_END (JSON)
 *
 * Events emitted:
 *   'blob:received' (hash, blob)
 *   'blob:progress' (hash, received, total)
 */

import { EventBus } from '../event-bus.js';

const BLOB_BATCH_LIMIT = 30;

export class BlobTransfer extends EventBus {
  /**
   * @param {object} opts
   * @param {import('../sync/message-router.js').MessageRouter} opts.router
   * @param {import('../storage/storage-interface.js').IStorage} opts.storage
   * @param {number} [opts.chunkSize=65536]
   * @param {number} [opts.maxBuffer=4194304]
   */
  constructor({ router, storage, chunkSize = 65536, maxBuffer = 4194304 }) {
    super();
    this._router    = router;
    this._storage   = storage;
    this._chunkSize = chunkSize;
    this._maxBuffer = maxBuffer;

    /** @type {Map<string, object>} key: "peerId:hash" → stream state */
    this._streams = new Map();

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
   * Send a blob to a peer using chunked binary streaming.
   * @param {string} peerId
   * @param {string} hash
   * @param {Blob}   blob
   * @param {object} [meta]   — optional { itemId, mime }
   */
  async sendBlob(peerId, hash, blob, meta = {}) {
    const dc = this._router._transport._dataChannels.get(peerId);
    if (!dc || dc.readyState !== 'open') return;

    try {
      const ab    = await blob.arrayBuffer();
      const mime  = blob.type || meta.mime || 'application/octet-stream';
      const total = Math.ceil(ab.byteLength / this._chunkSize);

      dc.send(JSON.stringify({
        type: 'BLOB_STREAM_START',
        hash, mime, total,
        size:   ab.byteLength,
        itemId: meta.itemId,
      }));

      for (let i = 0; i < total; i++) {
        // Backpressure control
        while (dc.bufferedAmount > this._maxBuffer) {
          await new Promise(r => {
            dc.onbufferedamountlow = r;
            setTimeout(r, 100);
          });
        }
        if (dc.readyState !== 'open') break;
        dc.send(ab.slice(i * this._chunkSize, (i + 1) * this._chunkSize));
      }

      dc.send(JSON.stringify({ type: 'BLOB_STREAM_END', hash }));
    } catch (e) {
      console.warn('[BlobTransfer] sendBlob error:', e.message);
    }
  }

  // ─────────────────────────── Internal handlers ───────────────────────────

  async _handleBlobReq(fromPeerId, msg) {
    if (!msg.hashes?.length) return;
    const hashes = msg.hashes.slice(0, BLOB_BATCH_LIMIT);

    for (const hash of hashes) {
      const blobRecord = await this._storage.getBlob(hash).catch(() => null);
      if (!blobRecord) continue;
      await this.sendBlob(fromPeerId, hash, blobRecord.blob, { itemId: blobRecord.itemId });
      // Small yield to avoid starving other messages
      await new Promise(r => setTimeout(r, 5));
    }
  }

  _handleBlobStreamStart(fromPeerId, msg) {
    if (!msg.hash) return;
    this._streams.set(`${fromPeerId}:${msg.hash}`, {
      hash:     msg.hash,
      mime:     msg.mime || 'application/octet-stream',
      itemId:   msg.itemId,
      total:    msg.total,
      size:     msg.size,
      chunks:   [],
      received: 0,
    });
  }

  _routeBinaryChunk(fromPeerId, ab) {
    for (const [key, state] of this._streams) {
      if (key.startsWith(`${fromPeerId}:`) && state.received < state.total) {
        state.chunks.push(ab);
        state.received++;
        this.emit('blob:progress', state.hash, state.received, state.total);
        return;
      }
    }
  }

  async _handleBlobStreamEnd(fromPeerId, msg) {
    const key   = `${fromPeerId}:${msg.hash}`;
    const state = this._streams.get(key);
    if (!state) return;
    this._streams.delete(key);

    try {
      const blob = new Blob(state.chunks, { type: state.mime });
      const exists = await this._storage.hasBlob(state.hash).catch(() => false);
      if (!exists) {
        await this._storage.addBlob(state.hash, blob, { itemId: state.itemId }).catch(() => {});
      }
      this.emit('blob:received', state.hash, blob);
    } catch (e) {
      console.warn('[BlobTransfer] stream assembly error:', e.message);
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
