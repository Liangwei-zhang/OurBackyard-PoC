/**
 * @file transport-interface.js
 * @description ITransport abstract interface — all transports must implement this contract.
 * Zero external dependencies.
 */

/**
 * @abstract
 * @class ITransport
 *
 * Lifecycle:
 *   connect(peerId, signalingChannel) → Promise<void>
 *   send(peerId, data)               → boolean  (false = backpressure)
 *   broadcast(data)                  → void
 *   disconnect(peerId)               → void
 *   close()                          → void
 *
 * Events emitted (via EventBus):
 *   'open'    { peerId }
 *   'message' { peerId, data }
 *   'close'   { peerId, reason }
 *   'error'   { peerId, error }
 */
export class ITransport {
  /**
   * Initiate a connection to a peer using the provided signaling channel.
   * @param {string} peerId
   * @param {object} signalingChannel
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async connect(peerId, signalingChannel) {
    throw new Error('ITransport.connect() must be implemented');
  }

  /**
   * Send data to a specific peer.
   * @param {string} peerId
   * @param {string|ArrayBuffer} data
   * @returns {boolean} false if backpressure prevents sending
   */
  // eslint-disable-next-line no-unused-vars
  send(peerId, data) {
    throw new Error('ITransport.send() must be implemented');
  }

  /**
   * Broadcast data to all connected peers.
   * @param {string|ArrayBuffer} data
   */
  // eslint-disable-next-line no-unused-vars
  broadcast(data) {
    throw new Error('ITransport.broadcast() must be implemented');
  }

  /**
   * Disconnect from a specific peer.
   * @param {string} peerId
   */
  // eslint-disable-next-line no-unused-vars
  disconnect(peerId) {
    throw new Error('ITransport.disconnect() must be implemented');
  }

  /**
   * Close all connections and release resources.
   */
  close() {
    throw new Error('ITransport.close() must be implemented');
  }

  /**
   * Return all currently connected peer IDs.
   * @returns {string[]}
   */
  peers() {
    throw new Error('ITransport.peers() must be implemented');
  }
}

export default ITransport;
