/**
 * @file reconnect-manager.js
 * @description Disconnection detection and exponential backoff reconnect manager.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('ReconnectManager');

/** @typedef {{ attempts: number, timer: number|null, paused: boolean }} PeerState */

export class ReconnectManager extends EventBus {
  /**
   * @param {object} opts
   * @param {Function} opts.reconnect — async (peerId: string) => void — called to re-establish connection
   */
  constructor(opts = {}) {
    super();
    if (typeof opts.reconnect !== 'function') throw new TypeError('opts.reconnect is required');
    this._reconnect = opts.reconnect;
    /** @type {Map<string, PeerState>} */
    this._state = new Map();
  }

  /**
   * Notify the manager that a peer has disconnected.
   * Starts exponential backoff reconnect loop.
   * @param {string} peerId
   */
  onDisconnect(peerId) {
    if (!peerId) return;
    if (!this._state.has(peerId)) {
      this._state.set(peerId, { attempts: 0, timer: null, paused: false });
    }
    const state = this._state.get(peerId);
    if (state.timer !== null || state.paused) return;
    this._schedule(peerId);
  }

  /**
   * Notify the manager that a peer has reconnected successfully.
   * Resets attempt counter.
   * @param {string} peerId
   */
  onConnect(peerId) {
    const state = this._state.get(peerId);
    if (!state) return;
    if (state.timer !== null) clearTimeout(state.timer);
    state.attempts = 0;
    state.timer = null;
    state.paused = false;
    log.debug(`Reconnect succeeded for ${peerId}`);
    this.emit('reconnected', { peerId });
  }

  /**
   * Pause reconnect attempts for a peer (e.g., circuit breaker open).
   * @param {string} peerId
   */
  pause(peerId) {
    const state = this._state.get(peerId);
    if (!state) return;
    if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
    state.paused = true;
  }

  /**
   * Resume reconnect attempts for a peer.
   * @param {string} peerId
   */
  resume(peerId) {
    const state = this._state.get(peerId);
    if (!state) return;
    state.paused = false;
    state.attempts = 0;
    this._schedule(peerId);
  }

  /**
   * Remove a peer from management (e.g., intentional disconnect).
   * @param {string} peerId
   */
  remove(peerId) {
    const state = this._state.get(peerId);
    if (!state) return;
    if (state.timer !== null) clearTimeout(state.timer);
    this._state.delete(peerId);
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /** @private */
  _schedule(peerId) {
    const state = this._state.get(peerId);
    if (!state || state.paused) return;

    const maxAttempts = config.get('transport.reconnectMaxAttempts');
    if (state.attempts >= maxAttempts) {
      log.warn(`Max reconnect attempts for ${peerId} — giving up`);
      this._state.delete(peerId);
      this.emit('give-up', { peerId });
      return;
    }

    const base = config.get('transport.reconnectBaseDelay');
    const maxDelay = config.get('transport.reconnectMaxDelay');
    const jitter = Math.random() * 500;
    const delay = Math.min(base * Math.pow(2, state.attempts), maxDelay) + jitter;
    state.attempts++;

    log.info(`Scheduling reconnect for ${peerId} in ${Math.round(delay)}ms (attempt ${state.attempts})`);
    state.timer = setTimeout(async () => {
      state.timer = null;
      try {
        await this._reconnect(peerId);
      } catch (e) {
        log.warn(`Reconnect attempt ${state.attempts} failed for ${peerId}`, e);
        this._schedule(peerId);
      }
    }, delay);
    state.timer?.unref?.();
  }
}

export default ReconnectManager;
