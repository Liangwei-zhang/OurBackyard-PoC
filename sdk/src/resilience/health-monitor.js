/**
 * @file health-monitor.js
 * @description Per-peer health scoring with RTT tracking via ping/pong messages.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('HealthMonitor');

/** @typedef {{ rtt: number[], lastPing: number|null, misses: number, score: number }} PeerHealth */

export class HealthMonitor extends EventBus {
  /**
   * @param {object} opts
   * @param {Function} opts.sendToPeer — (peerId: string, msg: string) => boolean
   */
  constructor(opts = {}) {
    super();
    if (typeof opts.sendToPeer !== 'function') throw new TypeError('opts.sendToPeer is required');
    this._send = opts.sendToPeer;
    /** @type {Map<string, PeerHealth>} */
    this._health = new Map();
    this._pingTimer = null;
  }

  /**
   * Start the periodic ping loop.
   */
  start() {
    const interval = config.get('healthMonitor.pingIntervalMs');
    this._pingTimer = setInterval(() => this._pingAll(), interval);
    log.info('HealthMonitor started');
  }

  /**
   * Stop the periodic ping loop.
   */
  stop() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  /**
   * Register a peer to monitor.
   * @param {string} peerId
   */
  addPeer(peerId) {
    if (!this._health.has(peerId)) {
      this._health.set(peerId, { rtt: [], lastPing: null, misses: 0, score: 100 });
    }
  }

  /**
   * Remove a peer from monitoring.
   * @param {string} peerId
   */
  removePeer(peerId) {
    this._health.delete(peerId);
  }

  /**
   * Handle an incoming ping — reply with pong.
   * @param {string} peerId
   * @param {{ type: string, ts: number }} msg
   */
  handlePing(peerId, msg) {
    if (msg.type !== 'health:ping') return;
    this._send(peerId, JSON.stringify({ type: 'health:pong', ts: msg.ts }));
  }

  /**
   * Handle an incoming pong — update RTT.
   * @param {string} peerId
   * @param {{ type: string, ts: number }} msg
   */
  handlePong(peerId, msg) {
    if (msg.type !== 'health:pong') return;
    const rtt = Date.now() - msg.ts;
    const h = this._health.get(peerId);
    if (!h) return;
    h.rtt.push(rtt);
    if (h.rtt.length > 20) h.rtt.shift();
    h.misses = 0;
    h.lastPing = null;
    h.score = Math.min(100, h.score + 10);
    this.emit('rtt', { peerId, rtt, avgRtt: this.avgRtt(peerId) });
  }

  /**
   * Return the average RTT for a peer in ms.
   * @param {string} peerId
   * @returns {number} — 0 if no data
   */
  avgRtt(peerId) {
    const h = this._health.get(peerId);
    if (!h || h.rtt.length === 0) return 0;
    return h.rtt.reduce((s, v) => s + v, 0) / h.rtt.length;
  }

  /**
   * Return the health score for a peer (0–100).
   * @param {string} peerId
   * @returns {number}
   */
  score(peerId) {
    return this._health.get(peerId)?.score ?? 0;
  }

  /**
   * Return whether a peer is considered healthy.
   * @param {string} peerId
   * @returns {boolean}
   */
  isHealthy(peerId) {
    const threshold = config.get('healthMonitor.unhealthyThreshold');
    const h = this._health.get(peerId);
    if (!h) return false;
    return h.misses < threshold;
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  /** @private */
  _pingAll() {
    const timeout = config.get('healthMonitor.pingTimeoutMs');
    const threshold = config.get('healthMonitor.unhealthyThreshold');
    for (const [peerId, h] of this._health.entries()) {
      const ts = Date.now();
      const sent = this._send(peerId, JSON.stringify({ type: 'health:ping', ts }));
      if (!sent) {
        h.misses++;
        h.score = Math.max(0, h.score - 20);
        log.warn(`Ping failed for ${peerId} — misses=${h.misses}`);
        if (h.misses >= threshold) {
          this.emit('unhealthy', { peerId, score: h.score });
        }
        continue;
      }
      h.lastPing = ts;
      // Timeout check
      setTimeout(() => {
        if (h.lastPing === ts) {
          // No pong received
          h.misses++;
          h.score = Math.max(0, h.score - 15);
          log.warn(`Pong timeout for ${peerId} — misses=${h.misses}`);
          if (h.misses >= threshold) {
            this.emit('unhealthy', { peerId, score: h.score });
          }
        }
      }, timeout);
    }
  }
}

export default HealthMonitor;
