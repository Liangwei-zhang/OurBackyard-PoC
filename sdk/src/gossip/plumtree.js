/**
 * Plumtree — Push-Lazy-Push Multicast Tree gossip protocol.
 *
 * Reference: "Plumtree: Epidemic Broadcast Trees" (Leitão et al., 2007)
 *
 * Each node maintains two peer sets:
 *   eagerPeers — receive full message pushes (spanning tree edges)
 *   lazyPeers  — receive only message IDs (random overlay edges)
 *
 * Protocol:
 *   On receive GOSSIP_FULL from eager peer:
 *     1. Deliver to application
 *     2. Forward full message to all OTHER eager peers
 *     3. Send GOSSIP_IHAVE to all lazy peers
 *     4. Move sender to eager set if not already there
 *
 *   On receive GOSSIP_IHAVE from lazy peer:
 *     1. If already have → ignore
 *     2. Start repair timer
 *     3. If full message not received before timer → send GOSSIP_GRAFT
 *
 *   On receive GOSSIP_GRAFT:
 *     1. Move sender to eager set
 *     2. Send full message to sender
 *
 *   On receive GOSSIP_PRUNE:
 *     1. Move sender from eager to lazy set
 *
 * Events emitted:
 *   'message'    (fromPeerId, msg) — delivered message
 *   'peer:eager' (peerId)          — peer promoted to eager
 *   'peer:lazy'  (peerId)          — peer demoted to lazy
 */

import { EventBus } from '../event-bus.js';
import { uuid } from '../utils.js';

const GOSSIP_FULL  = 'GOSSIP_FULL';
const GOSSIP_IHAVE = 'GOSSIP_IHAVE';
const GOSSIP_GRAFT = 'GOSSIP_GRAFT';
const GOSSIP_PRUNE = 'GOSSIP_PRUNE';

/** Maximum number of message IDs to remember (LRU eviction) */
const MAX_SEEN = 1000;

export class Plumtree extends EventBus {
  /**
   * @param {object} opts
   * @param {import('../sync/message-router.js').MessageRouter} opts.router
   * @param {string}  opts.peerId
   * @param {number}  [opts.repairTimeoutMs=500]
   */
  constructor({ router, peerId, repairTimeoutMs = 500 }) {
    super();
    this._router          = router;
    this._peerId          = peerId;
    this._repairTimeoutMs = repairTimeoutMs;

    /** @type {Set<string>} peers receiving full pushes */
    this._eagerPeers = new Set();
    /** @type {Set<string>} peers receiving only IHAVE */
    this._lazyPeers  = new Set();

    /**
     * LRU buffer of seen message IDs.
     * @type {string[]}
     */
    this._seen = [];

    /**
     * Map of msgId → { fullMsg, fromPeerId } for messages we have.
     * @type {Map<string, object>}
     */
    this._messages = new Map();

    /**
     * Pending repair timers: msgId → { timer, lazyPeerId }
     * @type {Map<string, { timer: any, lazyPeerId: string }>}
     */
    this._repairTimers = new Map();

    // Register handlers
    router.handle(GOSSIP_FULL,  (from, msg) => this._onFull(from, msg));
    router.handle(GOSSIP_IHAVE, (from, msg) => this._onIHave(from, msg));
    router.handle(GOSSIP_GRAFT, (from, msg) => this._onGraft(from, msg));
    router.handle(GOSSIP_PRUNE, (from, msg) => this._onPrune(from, msg));
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Add a peer. New peers start in eager set.
   * @param {string} peerId
   */
  addPeer(peerId) {
    if (peerId === this._peerId) return;
    this._eagerPeers.add(peerId);
    this._lazyPeers.delete(peerId);
  }

  /**
   * Remove a peer from all sets.
   * @param {string} peerId
   */
  removePeer(peerId) {
    this._eagerPeers.delete(peerId);
    this._lazyPeers.delete(peerId);
    // Cancel any pending repair timers for this peer
    for (const [msgId, entry] of this._repairTimers) {
      if (entry.lazyPeerId === peerId) {
        clearTimeout(entry.timer);
        this._repairTimers.delete(msgId);
      }
    }
  }

  /**
   * Broadcast a message to the mesh.
   * @param {string} msgType   — Application-level message type
   * @param {*}      payload
   */
  broadcast(msgType, payload) {
    const msgId = uuid();
    const msg = { id: msgId, msgType, payload, origin: this._peerId };

    // Mark as seen
    this._markSeen(msgId);
    this._messages.set(msgId, msg);

    // Push full message to eager peers
    for (const peer of this._eagerPeers) {
      this._router.send(peer, GOSSIP_FULL, { msg });
    }

    // Send IHAVE to lazy peers
    for (const peer of this._lazyPeers) {
      this._router.send(peer, GOSSIP_IHAVE, { msgId });
    }
  }

  // ─────────────────────────── Internal handlers ───────────────────────────

  _onFull(fromPeerId, envelope) {
    const msg = envelope.msg;
    if (!msg || !msg.id) return;

    const alreadySeen = this._isSeen(msg.id);

    if (alreadySeen) {
      // Duplicate — prune the sender
      this._router.send(fromPeerId, GOSSIP_PRUNE, {});
      this._moveToLazy(fromPeerId);
      return;
    }

    // New message
    this._markSeen(msg.id);
    this._messages.set(msg.id, msg);

    // Cancel any pending repair timer for this message
    const repair = this._repairTimers.get(msg.id);
    if (repair) {
      clearTimeout(repair.timer);
      this._repairTimers.delete(msg.id);
    }

    // Deliver to application
    this.emit('message', fromPeerId, msg);

    // Ensure sender is in eager set
    this._moveToEager(fromPeerId);

    // Forward to other eager peers
    for (const peer of this._eagerPeers) {
      if (peer !== fromPeerId) {
        this._router.send(peer, GOSSIP_FULL, { msg });
      }
    }

    // IHAVE to lazy peers
    for (const peer of this._lazyPeers) {
      this._router.send(peer, GOSSIP_IHAVE, { msgId: msg.id });
    }
  }

  _onIHave(fromPeerId, envelope) {
    const { msgId } = envelope;
    if (!msgId) return;

    // Already have this message → ignore
    if (this._isSeen(msgId)) return;

    // Don't start duplicate repair timer
    if (this._repairTimers.has(msgId)) return;

    // Start repair timer
    const timer = setTimeout(() => {
      this._repairTimers.delete(msgId);
      // If we still don't have the message, GRAFT the lazy peer
      if (!this._isSeen(msgId)) {
        this._router.send(fromPeerId, GOSSIP_GRAFT, { msgId });
        this._moveToEager(fromPeerId);
      }
    }, this._repairTimeoutMs);

    this._repairTimers.set(msgId, { timer, lazyPeerId: fromPeerId });
  }

  _onGraft(fromPeerId, envelope) {
    const { msgId } = envelope;
    // Promote sender to eager
    this._moveToEager(fromPeerId);

    // Send the full message if we have it
    if (msgId && this._messages.has(msgId)) {
      this._router.send(fromPeerId, GOSSIP_FULL, { msg: this._messages.get(msgId) });
    }
  }

  _onPrune(fromPeerId) {
    this._moveToLazy(fromPeerId);
  }

  // ─────────────────────────── Helpers ───────────────────────────

  _moveToEager(peerId) {
    if (peerId === this._peerId) return;
    if (!this._eagerPeers.has(peerId)) {
      this._eagerPeers.add(peerId);
      this._lazyPeers.delete(peerId);
      this.emit('peer:eager', peerId);
    }
  }

  _moveToLazy(peerId) {
    if (peerId === this._peerId) return;
    if (!this._lazyPeers.has(peerId)) {
      this._lazyPeers.add(peerId);
      this._eagerPeers.delete(peerId);
      this.emit('peer:lazy', peerId);
    }
  }

  _isSeen(msgId) {
    return this._seen.includes(msgId);
  }

  _markSeen(msgId) {
    if (this._seen.includes(msgId)) return;
    this._seen.push(msgId);
    if (this._seen.length > MAX_SEEN) this._seen.shift();
  }
}
