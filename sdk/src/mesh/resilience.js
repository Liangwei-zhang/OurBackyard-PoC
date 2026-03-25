import { EventBus } from '../event-bus.js';
import { uuid } from '../utils.js';

/**
 * Connection quality levels.
 */
export const Quality = Object.freeze({
  EXCELLENT: 4,
  GOOD:      3,
  FAIR:      2,
  POOR:      1,
  DEAD:      0,
});

const DEFAULT_HEARTBEAT_MS    = 15000;
const DEFAULT_MAX_RECONNECT   = 5;
const DEFAULT_RECONNECT_BASE  = 1000;
const CIRCUIT_BREAKER_COOL_MS = 60000; // 1 minute cooldown after max failures

/**
 * ResilienceManager — Connection health monitoring and automatic recovery.
 *
 * Features:
 *  - Heartbeat ping/pong with configurable interval (default 15 s)
 *  - RTT (round-trip time) tracking per peer
 *  - Automatic reconnection with exponential backoff (max 5 attempts)
 *  - Connection quality scoring (excellent/good/fair/poor/dead)
 *  - Peer reputation tracking (uptime ratio, message reliability)
 *  - Circuit breaker pattern for repeatedly failing peers
 *  - Graceful degradation: reduce sync frequency when connectivity is poor
 *
 * Events: 'peer:healthy', 'peer:degraded', 'peer:dead', 'peer:reconnected', 'health:report'
 */
export class ResilienceManager extends EventBus {
  /**
   * @param {object} opts
   * @param {import('../sync/message-router.js').MessageRouter} opts.router
   * @param {import('../transport/webrtc-transport.js').WebRTCTransport} opts.transport
   * @param {number} [opts.heartbeatIntervalMs=15000]
   * @param {number} [opts.maxReconnectAttempts=5]
   * @param {number} [opts.reconnectBaseMs=1000]
   * @param {number} [opts.pongTimeoutMs=5000] - Time to wait for PONG before marking peer degraded
   */
  constructor({
    router,
    transport,
    heartbeatIntervalMs  = DEFAULT_HEARTBEAT_MS,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT,
    reconnectBaseMs      = DEFAULT_RECONNECT_BASE,
    pongTimeoutMs        = 5000,
  }) {
    super();
    if (!router)    throw new TypeError('router is required');
    if (!transport) throw new TypeError('transport is required');

    this._router    = router;
    this._transport = transport;
    this._heartbeatIntervalMs  = heartbeatIntervalMs;
    this._maxReconnectAttempts = maxReconnectAttempts;
    this._reconnectBaseMs      = reconnectBaseMs;
    this._pongTimeoutMs        = pongTimeoutMs;

    /** @type {Function|null} (toPeerId, message) => void */
    this._sendFn = null;

    /**
     * peerId → {
     *   lastPing: number, lastPong: number, rtt: number,
     *   reconnectAttempts: number, quality: number,
     *   totalPings: number, totalPongs: number,
     *   circuitOpen: boolean, circuitOpenAt: number,
     *   reconnectTimer: any
     * }
     * @type {Map<string, object>}
     */
    this._peerHealth = new Map();

    /** @type {any} interval handle */
    this._heartbeatTimer = null;

    router.handle('PING', (from, msg) => this._onPing(from, msg));
    router.handle('PONG', (from, msg) => this._onPong(from, msg));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start the heartbeat monitor. Sends PING to all tracked peers periodically.
   */
  startMonitoring() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => this._heartbeatTick(), this._heartbeatIntervalMs);
  }

  /**
   * Stop the heartbeat monitor.
   */
  stopMonitoring() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    // Clear any pending reconnect timers
    for (const health of this._peerHealth.values()) {
      if (health.reconnectTimer) {
        clearTimeout(health.reconnectTimer);
        health.reconnectTimer = null;
      }
    }
  }

  /**
   * Register a new peer to monitor. Safe to call multiple times.
   * @param {string} peerId
   */
  trackPeer(peerId) {
    if (!peerId || this._peerHealth.has(peerId)) return;
    this._peerHealth.set(peerId, {
      lastPing:          0,
      lastPong:          0,
      rtt:               0,
      reconnectAttempts: 0,
      quality:           Quality.GOOD,
      totalPings:        0,
      totalPongs:        0,
      circuitOpen:       false,
      circuitOpenAt:     0,
      reconnectTimer:    null,
    });
  }

  /**
   * Remove a peer from monitoring.
   * @param {string} peerId
   */
  untrackPeer(peerId) {
    const health = this._peerHealth.get(peerId);
    if (health && health.reconnectTimer) {
      clearTimeout(health.reconnectTimer);
    }
    this._peerHealth.delete(peerId);
  }

  /**
   * Get health metrics for a single peer.
   * @param {string} peerId
   * @returns {{rtt: number, quality: number, reconnectAttempts: number, circuitOpen: boolean, reliability: number}|null}
   */
  getPeerHealth(peerId) {
    const h = this._peerHealth.get(peerId);
    if (!h) return null;
    return {
      rtt:               h.rtt,
      quality:           h.quality,
      reconnectAttempts: h.reconnectAttempts,
      circuitOpen:       h.circuitOpen,
      reliability:       this._getReliability(h),
      lastPong:          h.lastPong,
    };
  }

  /**
   * Get health metrics for all tracked peers.
   * @returns {Map<string, object>}
   */
  getAllHealth() {
    const result = new Map();
    for (const [peerId] of this._peerHealth) {
      result.set(peerId, this.getPeerHealth(peerId));
    }
    return result;
  }

  /**
   * Return peers with quality >= FAIR (i.e., usable).
   * @returns {string[]}
   */
  getHealthyPeers() {
    const healthy = [];
    for (const [peerId, h] of this._peerHealth) {
      if (h.quality >= Quality.FAIR && !h.circuitOpen) {
        healthy.push(peerId);
      }
    }
    return healthy;
  }

  /**
   * Get quality enum value for a peer.
   * @param {string} peerId
   * @returns {number} Quality constant
   */
  getPeerQuality(peerId) {
    const h = this._peerHealth.get(peerId);
    return h ? h.quality : Quality.DEAD;
  }

  /**
   * Manually notify that a peer has reconnected (e.g., from transport events).
   * Resets reconnect counter and circuit breaker.
   * @param {string} peerId
   */
  onPeerReconnected(peerId) {
    const h = this._peerHealth.get(peerId);
    if (!h) return;
    h.reconnectAttempts = 0;
    h.circuitOpen = false;
    h.quality = Quality.GOOD;
    this.emit('peer:reconnected', { peerId });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** @private */
  _heartbeatTick() {
    const now = Date.now();
    for (const [peerId, h] of this._peerHealth) {
      if (h.circuitOpen) {
        // Check if cooldown has expired
        if (now - h.circuitOpenAt > CIRCUIT_BREAKER_COOL_MS) {
          h.circuitOpen = false;
          h.reconnectAttempts = 0;
        } else {
          continue;
        }
      }
      this._sendPing(peerId);

      // Schedule pong timeout check
      const pingTs = now;
      setTimeout(() => {
        const current = this._peerHealth.get(peerId);
        if (!current) return;
        // If no pong received since ping
        if (current.lastPong < pingTs) {
          this._onPongMissed(peerId);
        }
      }, this._pongTimeoutMs);
    }

    // Emit a health report
    this.emit('health:report', { timestamp: now, peers: Object.fromEntries(this.getAllHealth()) });
  }

  /**
   * Set the send function for outbound messages.
   * @param {Function} fn - (toPeerId, message) => void|Promise<void>
   */
  setSendFn(fn) {
    this._sendFn = fn;
  }

  /** @private */
  _sendPing(peerId) {
    const h = this._peerHealth.get(peerId);
    if (!h || !this._sendFn) return;
    const ts = Date.now();
    h.lastPing = ts;
    h.totalPings++;
    try {
      this._sendFn(peerId, { type: 'PING', id: uuid(), ts });
    } catch {
      // Transport may not be connected yet
    }
  }

  /** @private */
  _onPing(from, msg) {
    if (!this._sendFn) return;
    // Reply with PONG immediately, echoing the ping's id
    try {
      this._sendFn(from, { type: 'PONG', id: uuid(), pingId: msg.id, pingTs: msg.ts });
    } catch {
      // ignore
    }
  }

  /** @private */
  _onPong(from, msg) {
    const h = this._peerHealth.get(from);
    if (!h) return;

    const now = Date.now();
    const rtt = msg.pingTs ? now - msg.pingTs : 0;
    h.lastPong = now;
    h.totalPongs++;
    h.rtt = rtt;
    h.reconnectAttempts = 0;

    const reliability = this._getReliability(h);
    const newQuality = this._calculateQuality(rtt, reliability);
    const prevQuality = h.quality;
    h.quality = newQuality;

    if (newQuality >= Quality.FAIR && prevQuality < Quality.FAIR) {
      this.emit('peer:healthy', { peerId: from, rtt, quality: newQuality });
    } else if (newQuality < Quality.FAIR && prevQuality >= Quality.FAIR) {
      this.emit('peer:degraded', { peerId: from, rtt, quality: newQuality });
    }
  }

  /** @private */
  _onPongMissed(peerId) {
    const h = this._peerHealth.get(peerId);
    if (!h) return;
    if (h.lastPong >= h.lastPing) return; // pong arrived between check scheduling and now

    h.quality = Math.max(Quality.DEAD, h.quality - 1);

    if (h.quality === Quality.DEAD) {
      this.emit('peer:dead', { peerId });
      this._attemptReconnect(peerId);
    } else {
      this.emit('peer:degraded', { peerId, quality: h.quality });
    }
  }

  /**
   * Calculate quality from RTT and reliability ratio.
   * @param {number} rtt - Round-trip time in ms
   * @param {number} reliability - 0..1 ratio of pongs/pings
   * @returns {number} Quality constant
   * @private
   */
  _calculateQuality(rtt, reliability) {
    if (reliability < 0.3) return Quality.POOR;
    if (rtt <= 0)    return Quality.GOOD; // Unknown RTT (first pong)
    if (rtt < 100)   return Quality.EXCELLENT;
    if (rtt < 300)   return Quality.GOOD;
    if (rtt < 1000)  return Quality.FAIR;
    return Quality.POOR;
  }

  /**
   * Attempt to reconnect to a peer using exponential backoff.
   * @param {string} peerId
   * @private
   */
  _attemptReconnect(peerId) {
    const h = this._peerHealth.get(peerId);
    if (!h) return;

    if (h.reconnectAttempts >= this._maxReconnectAttempts) {
      this._openCircuitBreaker(peerId);
      return;
    }

    h.reconnectAttempts++;
    const delay = this._reconnectBaseMs * Math.pow(2, h.reconnectAttempts - 1);

    h.reconnectTimer = setTimeout(async () => {
      if (!this._peerHealth.has(peerId)) return;
      try {
        await this._transport.connect(peerId, true);
        this.onPeerReconnected(peerId);
      } catch {
        // Will be retried on next heartbeat miss
      }
    }, delay);
  }

  /**
   * Open circuit breaker for a peer — stop reconnecting for a cooldown period.
   * @param {string} peerId
   * @private
   */
  _openCircuitBreaker(peerId) {
    const h = this._peerHealth.get(peerId);
    if (!h) return;
    h.circuitOpen = true;
    h.circuitOpenAt = Date.now();
    h.quality = Quality.DEAD;
    this.emit('peer:dead', { peerId, circuitOpen: true });
  }

  /**
   * Calculate message reliability (pong/ping ratio).
   * @param {object} h - Health object
   * @returns {number} 0..1
   * @private
   */
  _getReliability(h) {
    if (h.totalPings === 0) return 1;
    return Math.min(1, h.totalPongs / h.totalPings);
  }
}
