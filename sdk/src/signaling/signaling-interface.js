/**
 * @file signaling-interface.js
 * @description ISignaling abstract interface — all signaling implementations must follow this contract.
 * Zero external dependencies.
 */

/**
 * @abstract
 * @class ISignaling
 *
 * Lifecycle:
 *   init(localId)      → Promise<void>
 *   announce()         → Promise<void>
 *   sendToPeer(peerId, msg) → void
 *   close()            → void
 *
 * Events emitted (via EventBus):
 *   'peer:announce' { peerId, publicKeyJWK?, cell? }
 *   'signal'        { from: peerId, msg: { type, sdp?, candidate? } }
 *   'error'         { error }
 *   'connected'     {}
 *   'disconnected'  {}
 */
export class ISignaling {
  /**
   * Initialize the signaling channel with the local peer ID.
   * @param {string} localId
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async init(localId) {
    throw new Error('ISignaling.init() must be implemented');
  }

  /**
   * Announce this peer's presence to the signaling network.
   * @returns {Promise<void>}
   */
  async announce() {
    throw new Error('ISignaling.announce() must be implemented');
  }

  /**
   * Send a signaling message to a specific peer.
   * @param {string} peerId
   * @param {object} msg
   */
  // eslint-disable-next-line no-unused-vars
  sendToPeer(peerId, msg) {
    throw new Error('ISignaling.sendToPeer() must be implemented');
  }

  /**
   * Close the signaling channel and release resources.
   */
  close() {
    throw new Error('ISignaling.close() must be implemented');
  }
}

export default ISignaling;
