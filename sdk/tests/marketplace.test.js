/**
 * Tests for MarketplaceProtocol.
 * Run with: node --test sdk/tests/marketplace.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { MarketplaceProtocol } from '../src/protocols/marketplace.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

// ── Mock P2PNode ─────────────────────────────────────────────────────────────

function makeNode(h3Cell = '8f283082affffff') {
  const handlers = new Map();
  const sent = [];
  const broadcast = [];
  const storage = new MemoryStorage();

  const router = {
    handle(type, fn) { handlers.set(type, fn); },
    _trigger(type, from, msg) { const h = handlers.get(type); if (h) return h(from, msg); },
  };

  const gossipSync = {
    _published: [],
    async publishItem(item) { this._published.push(item); return 'msgid'; },
    updateItemStatus(id, status) {},
    addFavorite(k, v) {},
  };

  const node = {
    _config:   { peerId: 'seller-1', h3Cell },
    router,
    gossipSync,
    storage, // expose for convenience in tests
    sendMessage(peerId, type, payload) { sent.push({ peerId, type, payload }); },
    broadcastMessage(type, payload) { broadcast.push({ type, payload }); },
    _sent: sent,
    _broadcast: broadcast,
  };
  // Link storage to config for protocol
  node._config.storage = storage;
  return node;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MarketplaceProtocol — createListing', () => {
  it('should create a listing with id/createdAt/sellerId', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);

    const listing = await mp.createListing({ title: 'Bike', price: 200, category: 'sports' });
    assert.ok(listing.id);
    assert.equal(listing.title, 'Bike');
    assert.equal(listing.sellerId, 'seller-1');
    assert.ok(listing.createdAt > 0);
    assert.equal(listing.status, 'available');
  });

  it('should store listing in storage', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    const listing = await mp.createListing({ title: 'Chair' });
    const stored = await node.storage.get(`item:${listing.id}`);
    assert.equal(stored.title, 'Chair');
  });

  it('should throw if title is missing', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    await assert.rejects(() => mp.createListing({}), /title is required/);
  });

  it('should include h3Cell in listing', async () => {
    const node = makeNode('8f2830821ffffff');
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    const listing = await mp.createListing({ title: 'Table' });
    assert.equal(listing.h3Cell, '8f2830821ffffff');
  });
});

describe('MarketplaceProtocol — updateListing', () => {
  it('should update listing status', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    const listing = await mp.createListing({ title: 'Sofa' });
    const updated = await mp.updateListing(listing.id, { status: 'sold' });
    assert.equal(updated.status, 'sold');
  });

  it('should preserve original fields on update', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    const listing = await mp.createListing({ title: 'Lamp', price: 30 });
    const updated = await mp.updateListing(listing.id, { status: 'reserved' });
    assert.equal(updated.title, 'Lamp');
    assert.equal(updated.price, 30);
  });
});

describe('MarketplaceProtocol — offers', () => {
  it('should create a purchase offer', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    const listing = await mp.createListing({ title: 'Desk' });
    const offer = await mp.makePurchaseOffer(listing.id, { amount: 100 });
    assert.ok(offer.id);
    assert.equal(offer.listingId, listing.id);
    assert.equal(offer.buyerId, 'seller-1');
    assert.equal(offer.status, 'pending');
  });

  it('should accept an offer', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    const listing = await mp.createListing({ title: 'Monitor' });
    const offer = await mp.makePurchaseOffer(listing.id, { amount: 150 });
    const accepted = await mp.acceptOffer(offer.id);
    assert.equal(accepted.status, 'accepted');
  });

  it('should reject an offer', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    const listing = await mp.createListing({ title: 'Keyboard' });
    const offer = await mp.makePurchaseOffer(listing.id, { amount: 50 });
    const rejected = await mp.rejectOffer(offer.id);
    assert.equal(rejected.status, 'rejected');
  });
});

describe('MarketplaceProtocol — reviews', () => {
  it('should submit a review', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    const review = await mp.submitReview('seller-2', { rating: 5, text: 'Great!' });
    assert.ok(review.id);
    assert.equal(review.sellerId, 'seller-2');
    assert.equal(review.rating, 5);
    assert.equal(review.reviewerId, 'seller-1');
  });

  it('should throw if rating is missing', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    await assert.rejects(() => mp.submitReview('s2', { text: 'ok' }), /rating is required/);
  });
});

describe('MarketplaceProtocol — searchListings', () => {
  it('should filter by text', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    await mp.createListing({ title: 'Mountain Bike', price: 500 });
    await mp.createListing({ title: 'City Scooter', price: 300 });

    const results = await mp.searchListings({ text: 'bike' });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Mountain Bike');
  });

  it('should filter by price range', async () => {
    const node = makeNode();
    const mp = new MarketplaceProtocol(node);
    mp.install(node);
    await mp.createListing({ title: 'Cheap', price: 10 });
    await mp.createListing({ title: 'Expensive', price: 1000 });

    const results = await mp.searchListings({ minPrice: 50 });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Expensive');
  });
});

describe('MarketplaceProtocol — getListingsByCell', () => {
  it('should return listings for a specific cell', async () => {
    const nodeA = makeNode('cell-A');
    const nodeB = makeNode('cell-B');
    const mpA = new MarketplaceProtocol(nodeA);
    const mpB = new MarketplaceProtocol(nodeB);
    mpA.install(nodeA);
    mpB.install(nodeB);

    await mpA.createListing({ title: 'In A' });
    await mpB.createListing({ title: 'In B' });

    const fromA = await mpA.getListingsByCell('cell-A');
    assert.equal(fromA.length, 1);
    assert.equal(fromA[0].title, 'In A');
  });
});
