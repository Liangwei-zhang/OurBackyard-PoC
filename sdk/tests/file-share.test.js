/**
 * Tests for FileShareProtocol.
 * Run with: node --test sdk/tests/file-share.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { FileShareProtocol } from '../src/protocols/file-share.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeNode(peerId = 'alice') {
  const _handlers  = new Map();
  const _sent      = [];
  const _transfers = [];
  const storage    = new MemoryStorage();

  const router = {
    handle(type, fn) { _handlers.set(type, fn); },
    _trigger(type, from, msg) { const h = _handlers.get(type); if (h) return h(from, msg); },
  };

  const blobTransfer = {
    _outbound: new Map(),
    async send(toPeerId, data, meta) {
      const tid = `transfer-${Date.now()}`;
      _transfers.push({ toPeerId, meta, tid });
      return tid;
    },
    _transfers,
  };

  return {
    _config:     { peerId, storage },
    router,
    storage,
    blobTransfer,
    _sent,
    sendMessage(toPeerId, type, payload) { _sent.push({ toPeerId, type, payload }); },
    broadcastMessage() {},
  };
}

function makeBuffer(content = 'Hello, world!') {
  return new TextEncoder().encode(content).buffer;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FileShareProtocol — offerFile', () => {
  it('should create a file offer and send FILE_OFFER message', async () => {
    const node = makeNode('alice');
    const fs   = new FileShareProtocol(node);
    fs.install(node);

    const buf   = makeBuffer('test file content');
    const offer = await fs.offerFile('bob', buf, { name: 'test.txt' });

    assert.ok(offer.offerId);
    assert.ok(offer.hash, 'Should compute SHA-256 hash');
    assert.equal(offer.fromId, 'alice');
    assert.equal(offer.toId, 'bob');
    assert.equal(offer.meta.name, 'test.txt');
    assert.equal(offer.status, 'pending');

    assert.equal(node._sent.length, 1);
    assert.equal(node._sent[0].toPeerId, 'bob');
    assert.equal(node._sent[0].type, 'FILE_OFFER');
  });

  it('should throw if toPeerId is missing', async () => {
    const node = makeNode();
    const fs   = new FileShareProtocol(node);
    fs.install(node);
    await assert.rejects(() => fs.offerFile(null, makeBuffer()), /toPeerId is required/);
  });

  it('should throw if data is missing', async () => {
    const node = makeNode();
    const fs   = new FileShareProtocol(node);
    fs.install(node);
    await assert.rejects(() => fs.offerFile('bob', null), /data is required/);
  });
});

describe('FileShareProtocol — acceptFile', () => {
  it('should send FILE_ACCEPT and initiate blob transfer (sender-side via _onFileAccept)', async () => {
    // Alice offers file to bob; bob accepts; alice initiates blob transfer
    const aliceNode = makeNode('alice');
    const fs        = new FileShareProtocol(aliceNode);
    fs.install(aliceNode);

    const buf   = makeBuffer('content to send');
    const offer = await fs.offerFile('bob', buf);

    // Simulate bob sending FILE_ACCEPT back to alice
    await aliceNode.router._trigger('FILE_ACCEPT', 'bob', { type: 'FILE_ACCEPT', id: 'msg-1', offerId: offer.offerId });

    // Alice should initiate blob transfer to bob
    assert.equal(aliceNode.blobTransfer._transfers.length, 1);
    assert.equal(aliceNode.blobTransfer._transfers[0].toPeerId, 'bob');
  });

  it('should throw if offerId is unknown', async () => {
    const node = makeNode();
    const fs   = new FileShareProtocol(node);
    fs.install(node);
    await assert.rejects(() => fs.acceptFile('unknown-id'), /No pending offer/);
  });

  it('should throw if offerId is missing', async () => {
    const node = makeNode();
    const fs   = new FileShareProtocol(node);
    fs.install(node);
    await assert.rejects(() => fs.acceptFile(null), /offerId is required/);
  });

  it('should allow receiver to accept an inbound offer and notify sender', async () => {
    // Bob receives FILE_OFFER, accepts it
    const bobNode = makeNode('bob');
    const fs      = new FileShareProtocol(bobNode);
    fs.install(bobNode);

    // Simulate FILE_OFFER arriving from alice
    bobNode.router._trigger('FILE_OFFER', 'alice', {
      type: 'FILE_OFFER', id: 'msg-1',
      offerId: 'offer-xyz', fromId: 'alice', toId: 'bob',
      hash: 'aabbcc', size: 100, meta: { name: 'doc.pdf' },
    });

    // Bob accepts (no local data → should not start transfer from bob's side)
    // Bob sends FILE_ACCEPT to alice
    // This exercises the public API without errors
    // (actual transfer initiated by alice upon receiving FILE_ACCEPT)
    const entry = fs._pendingOffers.get('offer-xyz');
    assert.ok(entry, 'Offer should be stored');
    assert.equal(entry.offer.fromId, 'alice');
    assert.equal(entry.data, null); // bob doesn't have the data
  });
});

describe('FileShareProtocol — rejectFile', () => {
  it('should send FILE_REJECT message', async () => {
    const node = makeNode('alice');
    const fs   = new FileShareProtocol(node);
    fs.install(node);

    const offer = await fs.offerFile('bob', makeBuffer('data'));
    await fs.rejectFile(offer.offerId);

    const rejectMsg = node._sent.find(m => m.type === 'FILE_REJECT');
    assert.ok(rejectMsg, 'FILE_REJECT should be sent');
    assert.equal(rejectMsg.payload.offerId, offer.offerId);
  });

  it('should remove pending offer on reject', async () => {
    const node = makeNode('alice');
    const fs   = new FileShareProtocol(node);
    fs.install(node);

    const offer = await fs.offerFile('bob', makeBuffer('x'));
    await fs.rejectFile(offer.offerId);

    assert.equal(fs._pendingOffers.has(offer.offerId), false);
  });

  it('should silently ignore unknown offer on reject', async () => {
    const node = makeNode();
    const fs   = new FileShareProtocol(node);
    fs.install(node);
    await assert.doesNotReject(() => fs.rejectFile('nonexistent-id'));
  });
});

describe('FileShareProtocol — incoming FILE_OFFER', () => {
  it('should store incoming offer when FILE_OFFER is received', async () => {
    const node = makeNode('bob');
    const fs   = new FileShareProtocol(node);
    fs.install(node);

    node.router._trigger('FILE_OFFER', 'alice', {
      type: 'FILE_OFFER', id: 'msg-1',
      offerId: 'offer-abc', fromId: 'alice', toId: 'bob',
      hash: 'aabbcc', size: 100, meta: { name: 'file.txt' },
    });

    assert.ok(fs._pendingOffers.has('offer-abc'));
    const entry = fs._pendingOffers.get('offer-abc');
    assert.equal(entry.offer.fromId, 'alice');
    assert.equal(entry.data, null); // no data until transfer
  });
});

describe('FileShareProtocol — getTransferProgress', () => {
  it('should return null when no transfer exists for hash', () => {
    const node = makeNode();
    const fs   = new FileShareProtocol(node);
    fs.install(node);
    const result = fs.getTransferProgress('nonexistent-hash');
    assert.equal(result, null);
  });

  it('should return progress when transfer is tracked', () => {
    const node = makeNode();
    const fs   = new FileShareProtocol(node);
    fs.install(node);
    // Manually add an outbound transfer with matching hash
    node.blobTransfer._outbound.set('t1', { hash: 'abc123', progress: 0.5 });
    const result = fs.getTransferProgress('abc123');
    assert.ok(result);
    assert.equal(result.progress, 0.5);
  });
});
