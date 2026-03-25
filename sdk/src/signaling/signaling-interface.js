/**
 * ISignaling — Interface contract for all signaling implementations.
 *
 * Concrete implementations must extend this class and implement all methods.
 * The EventBus mixin provides typed event emission without Node.js dependency.
 *
 * Events emitted:
 *   'signal'        (fromPeerId, signal) — incoming WebRTC signal (offer/answer/ICE)
 *   'peer:announce' (peerId, meta)       — a peer has announced its presence
 *   'status'        ('online'|'offline') — connectivity state changed
 */

import { EventBus } from '../event-bus.js';

export class ISignaling extends EventBus {
  /**
   * Connect to the signaling channel.
   * Must resolve once at least one channel is ready.
   * @returns {Promise<void>}
   */
  async connect() { throw new Error('ISignaling.connect() not implemented'); }

  /**
   * Gracefully disconnect from the signaling channel.
   * @returns {Promise<void>}
   */
  async disconnect() { throw new Error('ISignaling.disconnect() not implemented'); }

  /**
   * Send a WebRTC signal to a specific peer.
   * @param {string} targetPeerId
   * @param {object} signal   — { type: 'offer'|'answer'|'ice-candidate', ... }
   * @returns {Promise<void>}
   */
  async sendSignal(targetPeerId, signal) { throw new Error('ISignaling.sendSignal() not implemented'); }

  /**
   * Announce this node's presence to the channel (peer discovery).
   * @param {object} [meta]  — optional metadata (e.g. ecdhPub, version)
   * @returns {Promise<void>}
   */
  async announce(meta = {}) { throw new Error('ISignaling.announce() not implemented'); }

  /**
   * Whether the signaling channel currently has at least one live connection.
   * @returns {boolean}
   */
  get isOnline() { return false; }
}
