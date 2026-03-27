/**
 * @file multi-signaling.js
 * @description Multi-signaling auto failover with priority ordering.
 * Delegates to the first available signaling backend: Nostr → WebSocket → LAN.
 * All backends receive outgoing signals; only the first active one counts for
 * incoming de-duplication.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';

const log = new Logger('MultiSignaling');

export class MultiSignaling extends EventBus {
  /**
   * @param {import('./signaling-interface.js').ISignaling[]} backends — ordered by priority
   */
  constructor(backends) {
    super();
    if (!Array.isArray(backends) || backends.length === 0) {
      throw new TypeError('backends must be a non-empty array');
    }
    this._backends = backends;
    this._localId = null;
    /** Track which backend events we've already forwarded to avoid duplicates */
    this._seenSignals = new Set();
  }

  // ─── ISignaling contract ─────────────────────────────────────────────────────

  async init(localId) {
    if (!localId) throw new TypeError('localId is required');
    this._localId = localId;

    const results = await Promise.allSettled(
      this._backends.map((b, i) => b.init(localId).then(() => i)),
    );

    const alive = results.filter(r => r.status === 'fulfilled');
    if (alive.length === 0) throw new Error('All signaling backends failed to initialize');

    log.info(`MultiSignaling: ${alive.length}/${this._backends.length} backends online`);

    // Wire events only from backends that initialised successfully
    const aliveBackends = results
      .filter(r => r.status === 'fulfilled')
      .map(r => this._backends[r.value]);
    for (const backend of aliveBackends) {
      backend.on('peer:announce', data => this.emit('peer:announce', data));
      backend.on('signal', data => {
        const key = `${data.from}:${JSON.stringify(data.msg)}`;
        if (this._seenSignals.has(key)) return;
        this._seenSignals.add(key);
        // Trim seen set to avoid unbounded growth
        if (this._seenSignals.size > 1000) {
          const oldest = this._seenSignals.values().next().value;
          this._seenSignals.delete(oldest);
        }
        this.emit('signal', data);
      });
      backend.on('connected', d => this.emit('connected', d));
      backend.on('disconnected', d => this.emit('disconnected', d));
      backend.on('error', d => this.emit('error', d));
    }

    this.emit('connected', {});
  }

  async announce() {
    await Promise.allSettled(this._backends.map(b => b.announce()));
  }

  sendToPeer(peerId, msg) {
    for (const backend of this._backends) {
      try { backend.sendToPeer(peerId, msg); } catch (e) {
        log.warn(`Backend sendToPeer failed`, e);
      }
    }
  }

  close() {
    for (const backend of this._backends) {
      try { backend.close(); } catch { /* ignore */ }
    }
  }
}

export default MultiSignaling;
