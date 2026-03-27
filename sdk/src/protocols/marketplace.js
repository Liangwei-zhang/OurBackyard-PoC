import { uuid } from '../utils.js';

/**
 * MarketplaceProtocol — P2P marketplace plugin for P2PNode.
 *
 * Handles listing creation/updates, purchase offers, and reviews over the P2P network.
 * Install as a plugin: `node.use(new MarketplaceProtocol(node))`
 *
 * Message types handled:
 *   LISTING_NEW, LISTING_UPDATE, OFFER_MAKE, OFFER_ACCEPT, OFFER_REJECT, REVIEW_SUBMIT
 */
export class MarketplaceProtocol {
  /**
   * @param {import('../p2p-node.js').P2PNode} p2pNode
   */
  constructor(p2pNode) {
    this._node = p2pNode;
    /** @type {import('../storage/storage-interface.js').IStorage|null} */
    this._storage = p2pNode._config?.storage || null;
  }

  // ── Plugin interface ──────────────────────────────────────────────────────

  /**
   * Install the protocol into a P2PNode.
   * @param {import('../p2p-node.js').P2PNode} node
   */
  install(node) {
    this._node    = node;
    this._storage = node._config?.storage || null;

    node.router.handle('LISTING_NEW',    (from, msg) => this._onListingNew(from, msg));
    node.router.handle('LISTING_UPDATE', (from, msg) => this._onListingUpdate(from, msg));
    node.router.handle('OFFER_MAKE',     (from, msg) => this._onOfferMake(from, msg));
    node.router.handle('OFFER_ACCEPT',   (from, msg) => this._onOfferAccept(from, msg));
    node.router.handle('OFFER_REJECT',   (from, msg) => this._onOfferReject(from, msg));
    node.router.handle('REVIEW_SUBMIT',  (from, msg) => this._onReviewSubmit(from, msg));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a new listing and gossip it to the network.
   * @param {object} listing - { title, price, description, category, ... }
   * @returns {Promise<object>} Created listing with id/createdAt/sellerId
   */
  async createListing(listing) {
    if (!listing || !listing.title) throw new TypeError('listing.title is required');

    const item = {
      id:         uuid(),
      ...listing,
      sellerId:   this._node._config.peerId,
      status:     'available',
      createdAt:  Date.now(),
      updatedAt:  Date.now(),
      h3Cell:     this._node._config.h3Cell,
    };

    if (this._storage) await this._storage.put(`listing:${item.id}`, item);

    // Gossip to network
    if (this._node.gossipSync) {
      await this._node.gossipSync.publishItem(item);
    } else {
      this._node.broadcastMessage('LISTING_NEW', { listing: item });
    }

    return item;
  }

  /**
   * Update an existing listing (LWW merge — later timestamp wins).
   * @param {string} id - Listing ID
   * @param {object} updates - Fields to update
   * @returns {Promise<object>} Updated listing
   */
  async updateListing(id, updates) {
    if (!id) throw new TypeError('id is required');
    let existing = this._storage ? await this._storage.get(`listing:${id}`) : null;
    if (!existing) existing = { id };

    const updated = { ...existing, ...updates, id, updatedAt: Date.now() };
    if (this._storage) await this._storage.put(`listing:${id}`, updated);

    if (this._node.gossipSync) {
      await this._node.gossipSync.updateItemStatus(id, updates.status || updated.status || 'available');
    }
    this._node.broadcastMessage('LISTING_UPDATE', { listing: updated });
    return updated;
  }

  /**
   * Send a purchase offer to a listing's seller.
   * @param {string} listingId
   * @param {object} offer - { amount, message, ... }
   * @returns {Promise<object>} Created offer
   */
  async makePurchaseOffer(listingId, offer) {
    if (!listingId) throw new TypeError('listingId is required');

    const offerObj = {
      id:         uuid(),
      listingId,
      buyerId:    this._node._config.peerId,
      status:     'pending',
      createdAt:  Date.now(),
      ...offer,
    };

    // Find seller from listing
    let sellerId = offer.sellerId;
    if (!sellerId && this._storage) {
      const listing = await this._storage.get(`listing:${listingId}`);
      sellerId = listing?.sellerId;
    }

    if (this._storage) await this._storage.put(`offer:${offerObj.id}`, offerObj);

    if (sellerId) {
      this._node.sendMessage(sellerId, 'OFFER_MAKE', { offer: offerObj });
    } else {
      this._node.broadcastMessage('OFFER_MAKE', { offer: offerObj });
    }

    return offerObj;
  }

  /**
   * Accept a purchase offer.
   * @param {string} offerId
   * @returns {Promise<object>} Updated offer
   */
  async acceptOffer(offerId) {
    if (!offerId) throw new TypeError('offerId is required');
    let offerObj = this._storage ? await this._storage.get(`offer:${offerId}`) : { id: offerId };
    offerObj = { ...offerObj, status: 'accepted', updatedAt: Date.now() };
    if (this._storage) await this._storage.put(`offer:${offerId}`, offerObj);

    if (offerObj.buyerId) {
      this._node.sendMessage(offerObj.buyerId, 'OFFER_ACCEPT', { offer: offerObj });
    }
    return offerObj;
  }

  /**
   * Reject a purchase offer.
   * @param {string} offerId
   * @returns {Promise<object>} Updated offer
   */
  async rejectOffer(offerId) {
    if (!offerId) throw new TypeError('offerId is required');
    let offerObj = this._storage ? await this._storage.get(`offer:${offerId}`) : { id: offerId };
    offerObj = { ...offerObj, status: 'rejected', updatedAt: Date.now() };
    if (this._storage) await this._storage.put(`offer:${offerId}`, offerObj);

    if (offerObj.buyerId) {
      this._node.sendMessage(offerObj.buyerId, 'OFFER_REJECT', { offer: offerObj });
    }
    return offerObj;
  }

  /**
   * Submit a review for a seller.
   * @param {string} sellerId
   * @param {object} review - { rating: 1-5, text, listingId? }
   * @returns {Promise<object>} Created review
   */
  async submitReview(sellerId, review) {
    if (!sellerId) throw new TypeError('sellerId is required');
    if (!review || review.rating == null) throw new TypeError('review.rating is required');

    const reviewObj = {
      id:         uuid(),
      sellerId,
      reviewerId: this._node._config.peerId,
      createdAt:  Date.now(),
      ...review,
    };

    if (this._storage) await this._storage.put(`review:${reviewObj.id}`, reviewObj);

    // Add to ORSet via GossipSync if available
    if (this._node.gossipSync) {
      this._node.gossipSync.addFavorite(`reviews:${sellerId}`, reviewObj.id);
    }

    this._node.broadcastMessage('REVIEW_SUBMIT', { review: reviewObj });
    return reviewObj;
  }

  /**
   * Search listings from local storage.
   * @param {object} query - { text?, category?, minPrice?, maxPrice?, status? }
   * @returns {Promise<object[]>}
   */
  async searchListings(query = {}) {
    if (!this._storage) return [];
    const all = await this._storage.getAll();
    return all
      .filter(e => e.key.startsWith('listing:'))
      .map(e => e.value)
      .filter(item => {
        if (!item) return false;
        if (query.status && item.status !== query.status) return false;
        if (query.category && item.category !== query.category) return false;
        if (query.minPrice != null && (item.price ?? 0) < query.minPrice) return false;
        if (query.maxPrice != null && (item.price ?? 0) > query.maxPrice) return false;
        if (query.text) {
          const needle = query.text.toLowerCase();
          const haystack = `${item.title || ''} ${item.description || ''}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      });
  }

  /**
   * Get listings filtered by H3 cell.
   * @param {string} h3Cell
   * @returns {Promise<object[]>}
   */
  async getListingsByCell(h3Cell) {
    if (!h3Cell) return [];
    if (!this._storage) return [];
    const all = await this._storage.getAll();
    return all
      .filter(e => e.key.startsWith('listing:'))
      .map(e => e.value)
      .filter(item => item && item.h3Cell === h3Cell);
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  /** @private */
  async _onListingNew(from, msg) {
    const listing = msg.listing;
    if (!listing?.id) return;
    if (this._storage) await this._storage.put(`listing:${listing.id}`, listing);
  }

  /** @private */
  async _onListingUpdate(from, msg) {
    const listing = msg.listing;
    if (!listing?.id) return;
    if (!this._storage) return;
    const existing = await this._storage.get(`listing:${listing.id}`);
    // LWW merge — strict > to prevent same-timestamp re-broadcast from overwriting
    if (!existing || (listing.updatedAt || 0) > (existing.updatedAt || 0)) {
      await this._storage.put(`listing:${listing.id}`, listing);
    }
  }

  /** @private */
  async _onOfferMake(from, msg) {
    const offer = msg.offer;
    if (!offer?.id) return;
    if (this._storage) await this._storage.put(`offer:${offer.id}`, offer);
  }

  /** @private */
  async _onOfferAccept(from, msg) {
    const offer = msg.offer;
    if (!offer?.id) return;
    if (this._storage) await this._storage.put(`offer:${offer.id}`, offer);
  }

  /** @private */
  async _onOfferReject(from, msg) {
    const offer = msg.offer;
    if (!offer?.id) return;
    if (this._storage) await this._storage.put(`offer:${offer.id}`, offer);
  }

  /** @private */
  async _onReviewSubmit(from, msg) {
    const review = msg.review;
    if (!review?.id) return;
    if (this._storage) await this._storage.put(`review:${review.id}`, review);
  }
}
