import { P2PNode } from '../p2p-node.js';

export interface FileOffer {
  offerId: string;
  fromPeerId: string;
  hash: string;
  meta: {
    name?: string;
    mimeType?: string;
    size?: number;
    [key: string]: unknown;
  };
}

/**
 * FileShareProtocol — P2P binary file sharing plugin.
 *
 * Install via: `node.use(new FileShareProtocol(node))`
 *
 * Message types: FILE_OFFER, FILE_ACCEPT, FILE_REJECT
 */
export declare class FileShareProtocol {
  constructor(p2pNode: P2PNode);

  /** Called automatically by P2PNode.use(). */
  install(node: P2PNode): void;

  /**
   * Offer a file to a peer.
   * The peer must call acceptFile() before the transfer starts.
   * @returns Offer object { offerId, hash, meta }
   */
  offerFile(
    toPeerId: string,
    data: ArrayBuffer | Uint8Array,
    meta?: { name?: string; mimeType?: string; size?: number; [key: string]: unknown }
  ): Promise<FileOffer>;

  /**
   * Accept an incoming file offer and begin transfer.
   * @param offerId - The offerId from a 'file:offer' event
   */
  acceptFile(offerId: string): Promise<ArrayBuffer>;

  /** Reject an incoming file offer. */
  rejectFile(offerId: string): Promise<void>;
}
