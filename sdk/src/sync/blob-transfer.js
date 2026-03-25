/**
 * @file blob-transfer.js
 * @description Chunked binary Blob/File transfer with backpressure control.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { uuid, ab2hex, hex2ab, sha256hex } from '../utils.js';
import { Logger } from '../logger.js';

const log = new Logger('BlobTransfer');

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks

export class BlobTransfer extends EventBus {
  /**
   * @param {object} opts
   * @param {Function} opts.sendToPeer — (peerId: string, data: string) => boolean
   */
  constructor(opts = {}) {
    super();
    if (typeof opts.sendToPeer !== 'function') throw new TypeError('opts.sendToPeer is required');
    this._send = opts.sendToPeer;
    /** @type {Map<string, { chunks: Uint8Array[], totalChunks: number, meta: object }>} */
    this._incoming = new Map();
  }

  /**
   * Send a Blob or ArrayBuffer to a peer.
   * @param {string} peerId
   * @param {Blob|ArrayBuffer} blob
   * @param {object} [meta] — arbitrary metadata (filename, mimeType, etc.)
   * @returns {Promise<void>}
   */
  async send(peerId, blob, meta = {}) {
    const buf = blob instanceof Blob ? await blob.arrayBuffer() : blob;
    const bytes = new Uint8Array(buf);
    const transferId = uuid();
    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);
    const hash = await sha256hex(ab2hex(bytes));

    // Send manifest
    const manifest = JSON.stringify({
      type: 'blob:manifest',
      transferId,
      totalChunks,
      totalBytes: bytes.length,
      hash,
      meta,
    });
    if (!this._send(peerId, manifest)) {
      throw new Error(`Cannot start blob transfer to ${peerId}: send returned false`);
    }

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const chunk = bytes.slice(start, start + CHUNK_SIZE);
      const chunkMsg = JSON.stringify({
        type: 'blob:chunk',
        transferId,
        index: i,
        data: ab2hex(chunk.buffer),
      });
      // Simple backpressure: retry until send succeeds (up to 100 times)
      let sent = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (this._send(peerId, chunkMsg)) { sent = true; break; }
        await new Promise(r => setTimeout(r, 50));
      }
      if (!sent) throw new Error(`Failed to send chunk ${i} after backpressure`);
      this.emit('progress', { peerId, transferId, sent: i + 1, total: totalChunks });
    }
  }

  /**
   * Handle an incoming blob message.
   * @param {{ type: string, transferId: string, [key: string]: * }} msg
   * @returns {Promise<void>}
   */
  async handleMessage(msg) {
    if (!msg?.type?.startsWith('blob:')) return;

    if (msg.type === 'blob:manifest') {
      this._incoming.set(msg.transferId, {
        chunks: new Array(msg.totalChunks).fill(null),
        totalChunks: msg.totalChunks,
        meta: msg,
      });
    } else if (msg.type === 'blob:chunk') {
      const transfer = this._incoming.get(msg.transferId);
      if (!transfer) return;
      transfer.chunks[msg.index] = new Uint8Array(hex2ab(msg.data));

      const received = transfer.chunks.filter(Boolean).length;
      this.emit('progress', {
        transferId: msg.transferId,
        received,
        total: transfer.totalChunks,
      });

      if (received === transfer.totalChunks) {
        // Reassemble
        const totalBytes = transfer.chunks.reduce((s, c) => s + c.length, 0);
        const full = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of transfer.chunks) {
          full.set(chunk, offset);
          offset += chunk.length;
        }
        this._incoming.delete(msg.transferId);
        this.emit('complete', {
          transferId: msg.transferId,
          buffer: full.buffer,
          meta: transfer.meta.meta,
        });
        log.info(`Blob transfer ${msg.transferId} complete (${totalBytes} bytes)`);
      }
    }
  }
}

export default BlobTransfer;
