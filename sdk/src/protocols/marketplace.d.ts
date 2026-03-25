import { P2PNode } from '../p2p-node.js';
import { IStorage } from '../storage/storage-interface.js';
import { MarketplaceItem } from '../sync/gossip-sync.js';

export interface Listing extends MarketplaceItem {
  title: string;
  price?: number;
  description?: string;
  category?: string;
}

export interface Offer {
  offerId: string;
  listingId: string;
  buyerId: string;
  price: number;
  message?: string;
  createdAt: number;
}

export interface Review {
  reviewId: string;
  listingId: string;
  reviewerId: string;
  sellerId: string;
  rating: number;
  comment?: string;
  createdAt: number;
}

/**
 * MarketplaceProtocol — P2P listing/offer/review plugin.
 *
 * Install via: `node.use(new MarketplaceProtocol(node))`
 *
 * Message types: LISTING_NEW, LISTING_UPDATE, OFFER_MAKE,
 *                OFFER_ACCEPT, OFFER_REJECT, REVIEW_SUBMIT
 */
export declare class MarketplaceProtocol {
  constructor(p2pNode: P2PNode);

  /** Called automatically by P2PNode.use(). */
  install(node: P2PNode): void;

  /** Create and gossip a new listing. */
  createListing(listing: Omit<Listing, 'id' | 'sellerId' | 'status' | 'createdAt' | 'updatedAt' | 'h3Cell'>): Promise<Listing>;

  /** Update fields of an existing listing. */
  updateListing(id: string, updates: Partial<Listing>): Promise<Listing>;

  /** Make a purchase offer on a listing. */
  makeOffer(listingId: string, price: number, message?: string): Promise<Offer>;

  /** Accept an incoming offer. */
  acceptOffer(offerId: string): Promise<void>;

  /** Reject an incoming offer. */
  rejectOffer(offerId: string): Promise<void>;

  /** Submit a review for a completed transaction. */
  submitReview(listingId: string, sellerId: string, rating: number, comment?: string): Promise<Review>;
}
