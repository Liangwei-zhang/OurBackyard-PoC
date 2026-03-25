/**
 * MerkleSync — Merkle tree-based anti-entropy synchronization.
 *
 * Compares local and remote Merkle trees to find missing/differing items
 * and exchanges only the items that differ. Much more efficient than
 * timestamp-based sync for large data sets.
 *
 * Protocol:
 *   1. syncWith(peerId) → send MERKLE_ROOT
 *   2. Remote replies with MERKLE_ROOT
 *   3. If roots match → done
 *   4. Exchange MERKLE_NODES (intermediate hashes) to narrow down diff
 *   5. Peer sends MERKLE_LEAVES (leaf keys + hashes) for differing subtrees
 *   6. Transfer MERKLE_ITEMS for missing items
 *
 * Events emitted:
 *   'sync:start'    (peerId)
 *   'sync:progress' (peerId, { matched, differing, transferred })
 *   'sync:complete' (peerId, { itemsSent, itemsReceived })
 *   'sync:error'    (peerId, error)
 */

import { EventBus } from '../event-bus.js';
import { MerkleTree } from './merkle-tree.js';
import { sha256hex } from '../utils.js';

const MERKLE_ROOT   = 'MERKLE_ROOT';
const MERKLE_NODES  = 'MERKLE_NODES';
const MERKLE_LEAVES = 'MERKLE_LEAVES';
const MERKLE_ITEMS  = 'MERKLE_ITEMS';

export class MerkleSync extends EventBus {
  /**
   * @param {object} opts
   * @param {import('./message-router.js').MessageRouter} opts.router
   * @param {import('../storage/storage-interface.js').IStorage} opts.storage
   * @param {string} opts.peerId
   */
  constructor({ router, storage, peerId }) {
    super();
    this._router  = router;
    this._storage = storage;
    this._peerId  = peerId;

    /** @type {MerkleTree} */
    this._tree = new MerkleTree(sha256hex);

    /**
     * In-progress sync sessions: peerId → { resolve, reject, itemsSent, itemsReceived }
     * @type {Map<string, object>}
     */
    this._sessions = new Map();

    // Register handlers
    router.handle(MERKLE_ROOT,   (from, msg) => this._onRoot(from, msg));
    router.handle(MERKLE_NODES,  (from, msg) => this._onNodes(from, msg));
    router.handle(MERKLE_LEAVES, (from, msg) => this._onLeaves(from, msg));
    router.handle(MERKLE_ITEMS,  (from, msg) => this._onItems(from, msg));
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Trigger a sync with a specific peer.
   * @param {string} peerId
   * @returns {Promise<{ itemsSent: number, itemsReceived: number }>}
   */
  async syncWith(peerId) {
    this.emit('sync:start', peerId);

    // Rebuild local tree before syncing
    await this.rebuild();

    return new Promise((resolve, reject) => {
      this._sessions.set(peerId, {
        resolve,
        reject,
        itemsSent: 0,
        itemsReceived: 0,
      });

      // Send our root hash
      this._router.send(peerId, MERKLE_ROOT, {
        rootHash: this._tree.getRootHash(),
        leafCount: this._tree.getLeafKeys().length,
      });

      // Timeout after 30 seconds
      const timeout = setTimeout(() => {
        if (this._sessions.has(peerId)) {
          this._sessions.delete(peerId);
          const err = new Error(`MerkleSync: timeout syncing with ${peerId}`);
          this.emit('sync:error', peerId, err);
          reject(err);
        }
      }, 30000);

      this._sessions.get(peerId)._timeout = timeout;
    });
  }

  /**
   * Rebuild the local Merkle tree from storage.
   */
  async rebuild() {
    const items = await this._storage.getItems(0, 10000).catch(() => []);
    const entries = await Promise.all(
      items.map(async item => {
        const key  = `${item.sellerId || ''}:${item.timestamp || 0}`;
        const hash = await sha256hex(JSON.stringify(item)).catch(() => key);
        return { key, hash };
      })
    );
    await this._tree.build(entries);
  }

  /**
   * Get sync status.
   * @returns {{ totalItems: number, treeDepth: number, rootHash: string }}
   */
  getSyncStatus() {
    return {
      totalItems: this._tree.getLeafKeys().length,
      treeDepth:  this._tree.depth,
      rootHash:   this._tree.getRootHash(),
    };
  }

  // ─────────────────────────── Internal handlers ───────────────────────────

  async _onRoot(fromPeerId, msg) {
    const { rootHash, leafCount } = msg;

    // If we're the responder (no active session), rebuild and reply
    if (!this._sessions.has(fromPeerId)) {
      await this.rebuild();
      this._router.send(fromPeerId, MERKLE_ROOT, {
        rootHash: this._tree.getRootHash(),
        leafCount: this._tree.getLeafKeys().length,
      });
    }

    // Roots match — done
    if (rootHash === this._tree.getRootHash()) {
      this._completeSession(fromPeerId, 0, 0);
      return;
    }

    // Roots differ — exchange leaf keys and hashes to find the diff
    const snapshot = this._tree.getSnapshot();
    this._router.send(fromPeerId, MERKLE_NODES, { levels: snapshot.levels });
  }

  async _onNodes(fromPeerId, msg) {
    const { levels } = msg;
    if (!levels) return;

    // Build a temporary tree from remote levels for comparison
    const remoteSnapshot = { levels };

    // Compare leaf hashes to find differing keys
    const localLeafHashes  = this._tree.getLevel(0);
    const remoteLeafHashes = levels[0] || [];

    // Send our leaf details (key + hash) for the remote to compute diff
    const leafKeys = this._tree.getLeafKeys();
    const leavesPayload = leafKeys.map((key, i) => ({ key, hash: localLeafHashes[i] || '' }));

    this._router.send(fromPeerId, MERKLE_LEAVES, { leaves: leavesPayload });
  }

  async _onLeaves(fromPeerId, msg) {
    const { leaves } = msg;
    if (!Array.isArray(leaves)) return;

    // Build a temporary tree from the remote leaves
    const remoteTree = new MerkleTree(sha256hex);
    await remoteTree.build(leaves);

    // Diff with our local tree
    const diffKeys = await MerkleTree.diff(this._tree, remoteTree);

    if (diffKeys.length === 0) {
      this._completeSession(fromPeerId, 0, 0);
      return;
    }

    this.emit('sync:progress', fromPeerId, {
      matched: leaves.length - diffKeys.length,
      differing: diffKeys.length,
      transferred: 0,
    });

    // Fetch the differing items from local storage and send them
    const items = await this._storage.getItems(0, 10000).catch(() => []);
    const keySet = new Set(diffKeys);
    const missing = items.filter(item => {
      const key = `${item.sellerId || ''}:${item.timestamp || 0}`;
      return keySet.has(key);
    }).map(item => {
      const copy = { ...item };
      delete copy.id;
      return copy;
    });

    if (missing.length > 0) {
      this._router.send(fromPeerId, MERKLE_ITEMS, { items: missing });
      const session = this._sessions.get(fromPeerId);
      if (session) session.itemsSent += missing.length;
    }

    this._completeSession(fromPeerId, missing.length, 0);
  }

  async _onItems(fromPeerId, msg) {
    const { items } = msg;
    if (!Array.isArray(items)) return;

    let received = 0;
    for (const item of items) {
      const key = `${item.sellerId || ''}:${item.timestamp || 0}`;
      const exists = await this._storage.hasItem(item.sellerId, item.timestamp).catch(() => false);
      if (!exists) {
        const storeItem = { ...item, _receivedFrom: fromPeerId };
        delete storeItem.id;
        await this._storage.addItem(storeItem).catch(() => {});
        // Update our tree
        const hash = await sha256hex(JSON.stringify(storeItem)).catch(() => key);
        await this._tree.insert(key, hash);
        received++;
      }
    }

    const session = this._sessions.get(fromPeerId);
    if (session) {
      session.itemsReceived += received;
      this._completeSession(fromPeerId, session.itemsSent || 0, session.itemsReceived);
    }
  }

  _completeSession(peerId, itemsSent, itemsReceived) {
    const session = this._sessions.get(peerId);
    if (!session) return;

    clearTimeout(session._timeout);
    this._sessions.delete(peerId);

    const result = { itemsSent, itemsReceived };
    this.emit('sync:complete', peerId, result);
    session.resolve(result);
  }
}
