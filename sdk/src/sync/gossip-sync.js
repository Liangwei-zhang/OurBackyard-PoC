/**
 * @file gossip-sync.js
 * @description Gossip protocol for P2P data synchronization with TTL-based flooding.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';
import { uuid } from '../utils.js';
import { Logger } from '../logger.js';
import config from '../config.js';

const log = new Logger('GossipSync');

export class GossipSync extends EventBus {
  /**
   * @param {object} opts
   * @param {Function} opts.broadcast — (data: string) => void — send to all peers
   * @param {Function} [opts.sendToPeer] — (peerId: string, data: string) => void
   */
  constructor(opts = {}) {
    super();
    if (typeof opts.broadcast !== 'function') throw new TypeError('opts.broadcast is required');
    this._broadcast = opts.broadcast;
    this._sendToPeer = opts.sendToPeer ?? null;
    /** @type {Map<string, *>} key → value store */
    this._store = new Map();
    /** @type {Set<string>} seen gossip IDs */
    this._seen = new Set();
  }

  /**
   * Gossip a key/value update to the network.
   * @param {string} key
   * @param {*} value
   */
  spread(key, value) {
    const msg = {
      id: uuid(),
      type: 'gossip:update',
      key,
      value,
      ttl: config.get('gossip.ttl'),
      ts: Date.now(),
    };
    this._store.set(key, value);
    this._broadcast(JSON.stringify(msg));
    this.emit('local:update', { key, value });
  }

  /**
   * Handle an incoming gossip message.
   * @param {{ id: string, type: string, key: string, value: *, ttl: number, ts: number }} msg
   */
  handleMessage(msg) {
    if (!msg?.id || msg.type !== 'gossip:update') return;
    if (this._seen.has(msg.id)) return;
    this._seen.add(msg.id);
    if (this._seen.size > 10000) {
      // Trim oldest — simple approach
      const first = this._seen.values().next().value;
      this._seen.delete(first);
    }

    const ttl = (msg.ttl ?? 1) - 1;
    this._store.set(msg.key, msg.value);
    this.emit('update', { key: msg.key, value: msg.value, ts: msg.ts });

    if (ttl > 0) {
      // Re-gossip with decremented TTL
      const forwarded = { ...msg, ttl };
      this._broadcast(JSON.stringify(forwarded));
    }
  }

  /**
   * Get a stored value by key.
   * @param {string} key
   * @returns {*}
   */
  get(key) { return this._store.get(key); }

  /**
   * Return the full store snapshot.
   * @returns {Map<string, *>}
   */
  snapshot() { return new Map(this._store); }
}

export default GossipSync;
