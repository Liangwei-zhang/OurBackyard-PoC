import { EventBus } from '../event-bus.js';
import { uuid, sha256hex } from '../utils.js';

/**
 * MerkleSync — efficient state reconciliation between peers using Merkle hash trees.
 *
 * Protocol:
 *  1. Build local Merkle tree from sorted storage keys
 *  2. Send SYNC_REQ with root hash to peer
 *  3. If roots match → in sync, done
 *  4. If roots differ → exchange tree levels to pinpoint differing subtrees
 *  5. Request only items that differ (bandwidth efficient)
 *
 * Events: 'sync:started', 'sync:completed', 'sync:conflict', 'sync:progress'
 */
export class MerkleSync extends EventBus {
  /**
   * @param {object} opts
   * @param {import('./message-router.js').MessageRouter} opts.router
   * @param {import('../storage/storage-interface.js').IStorage} opts.storage
   * @param {string} opts.peerId
   * @param {number} [opts.syncIntervalMs=30000]
   * @param {number} [opts.maxItemsPerSync=500]
   */
  constructor({ router, storage, peerId, syncIntervalMs = 30000, maxItemsPerSync = 500 }) {
    super();
    if (!router) throw new TypeError('router is required');
    if (!storage) throw new TypeError('storage is required');
    if (!peerId) throw new TypeError('peerId is required');

    this._router = router;
    this._storage = storage;
    this._peerId = peerId;
    this._syncIntervalMs = syncIntervalMs;
    this._maxItemsPerSync = maxItemsPerSync;
    this._intervalId = null;

    /** @type {Map<string, object>} - sessionId -> pending sync state */
    this._sessions = new Map();

    router.handle('SYNC_REQ', (from, msg) => this._onSyncReq(from, msg));
    router.handle('SYNC_RESP', (from, msg) => this._onSyncResp(from, msg));
    router.handle('SYNC_TREE_REQ', (from, msg) => this._onSyncTreeReq(from, msg));
    router.handle('SYNC_TREE_RESP', (from, msg) => this._onSyncTreeResp(from, msg));
    router.handle('SYNC_ITEMS_REQ', (from, msg) => this._onSyncItemsReq(from, msg));
    router.handle('SYNC_ITEMS_RESP', (from, msg) => this._onSyncItemsResp(from, msg));
  }

  // ── Tree building ─────────────────────────────────────────────────────────

  /**
   * Build a Merkle tree from storage items.
   * @param {number} [since=0] - Only include items updated since this timestamp
   * @returns {Promise<{root: string, levels: string[][], leafCount: number, leaves: Array<{key:string, hash:string}>}>}
   */
  async buildTree(since = 0) {
    const items = await this._storage.getAll({ since });
    // Sort by key for determinism
    items.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

    if (items.length === 0) {
      return { root: await sha256hex(''), levels: [], leafCount: 0, leaves: [] };
    }

    // Build leaf hashes
    const leaves = await Promise.all(items.map(async item => ({
      key: item.key,
      hash: await sha256hex(item.key + ':' + JSON.stringify(item.value)),
    })));

    const levels = [leaves.map(l => l.hash)];

    // Build Merkle tree bottom-up
    let current = levels[0];
    while (current.length > 1) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1] || left; // odd node: duplicate
        next.push(await sha256hex(left + right));
      }
      levels.push(next);
      current = next;
    }

    const root = levels[levels.length - 1][0];
    return { root, levels, leafCount: items.length, leaves };
  }

  // ── Sync initiation ───────────────────────────────────────────────────────

  /**
   * Initiate a sync session with a peer.
   * @param {string} peerId
   * @param {number} [since=0]
   * @returns {Promise<{synced: boolean, itemsSynced: number}>}
   */
  async syncWithPeer(peerId, since = 0) {
    if (!peerId) throw new TypeError('peerId is required');
    const sessionId = uuid();

    this.emit('sync:started', { sessionId, peerId });

    const tree = await this.buildTree(since);
    const session = { sessionId, peerId, since, tree, resolve: null, reject: null };

    const promise = new Promise((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
      // Timeout after 30s
      session.timeout = setTimeout(() => {
        this._sessions.delete(sessionId);
        reject(new Error(`Sync session ${sessionId} timed out`));
      }, 30000);
    });

    this._sessions.set(sessionId, session);

    await this._sendTo(peerId, {
      type: 'SYNC_REQ',
      id: uuid(),
      sessionId,
      root: tree.root,
      leafCount: tree.leafCount,
      since,
    });

    return promise;
  }

  // ── Periodic sync ─────────────────────────────────────────────────────────

  /**
   * Start periodic sync with known peers.
   * @param {Function} getPeers - () => string[] - callback that returns current peer IDs
   */
  startPeriodicSync(getPeers) {
    if (this._intervalId) return;
    this._intervalId = setInterval(async () => {
      const peers = typeof getPeers === 'function' ? getPeers() : [];
      for (const peerId of peers) {
        try { await this.syncWithPeer(peerId); } catch (e) { /* ignore individual failures */ }
      }
    }, this._syncIntervalMs);
    this._intervalId?.unref?.();
  }

  /** Stop periodic sync. */
  stopPeriodicSync() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /** Clean up resources. */
  destroy() {
    this.stopPeriodicSync();
    for (const session of this._sessions.values()) {
      clearTimeout(session.timeout);
    }
    this._sessions.clear();
  }

  // ── Protocol handlers ─────────────────────────────────────────────────────

  /** @private */
  async _onSyncReq(from, msg) {
    const { sessionId, root: remoteRoot, leafCount: remoteLeafCount, since = 0 } = msg;
    const tree = await this.buildTree(since);

    if (tree.root === remoteRoot) {
      // In sync
      await this._sendTo(from, {
        type: 'SYNC_RESP',
        id: uuid(),
        sessionId,
        inSync: true,
        root: tree.root,
      });
    } else {
      // Need to diff — send our tree levels
      await this._sendTo(from, {
        type: 'SYNC_RESP',
        id: uuid(),
        sessionId,
        inSync: false,
        root: tree.root,
        levels: tree.levels,
        leafCount: tree.leafCount,
        leaves: tree.leaves,
      });
    }
  }

  /** @private */
  async _onSyncResp(from, msg) {
    const { sessionId, inSync, root: remoteRoot, levels: remoteLevels, leaves: remoteLeaves } = msg;
    const session = this._sessions.get(sessionId);
    if (!session) return;

    if (inSync) {
      this._completeSession(session, { synced: true, itemsSynced: 0 });
      return;
    }

    // Find differing subtrees by comparing levels
    const localTree = session.tree;
    if (!remoteLevels || !remoteLeaves) {
      this._completeSession(session, { synced: false, itemsSynced: 0 });
      return;
    }

    // Find which leaf keys we're missing or different
    const remoteLeafMap = new Map(remoteLeaves.map(l => [l.key, l.hash]));
    const localLeafMap = new Map(localTree.leaves ? localTree.leaves.map(l => [l.key, l.hash]) : []);

    const missingKeys = [];
    for (const [key, remoteHash] of remoteLeafMap) {
      const localHash = localLeafMap.get(key);
      if (localHash !== remoteHash) {
        missingKeys.push(key);
      }
    }

    if (missingKeys.length === 0) {
      this._completeSession(session, { synced: true, itemsSynced: 0 });
      return;
    }

    // Request only the differing items (up to maxItemsPerSync)
    const toRequest = missingKeys.slice(0, this._maxItemsPerSync);
    session.expectedKeys = toRequest;

    await this._sendTo(from, {
      type: 'SYNC_ITEMS_REQ',
      id: uuid(),
      sessionId,
      keys: toRequest,
    });
  }

  /** @private */
  async _onSyncTreeReq(from, msg) {
    const { sessionId, since = 0 } = msg;
    const tree = await this.buildTree(since);
    await this._sendTo(from, {
      type: 'SYNC_TREE_RESP',
      id: uuid(),
      sessionId,
      levels: tree.levels,
      leafCount: tree.leafCount,
      leaves: tree.leaves,
    });
  }

  /** @private */
  _onSyncTreeResp(from, msg) {
    // Used in multi-round diff (not needed for our simplified implementation)
  }

  /** @private */
  async _onSyncItemsReq(from, msg) {
    const { sessionId, keys } = msg;
    const items = [];
    for (const key of keys) {
      const value = await this._storage.get(key);
      if (value !== null) items.push({ key, value });
    }
    await this._sendTo(from, {
      type: 'SYNC_ITEMS_RESP',
      id: uuid(),
      sessionId,
      items,
    });
  }

  /** @private */
  async _onSyncItemsResp(from, msg) {
    const { sessionId, items } = msg;
    const session = this._sessions.get(sessionId);
    if (!session) return;

    let synced = 0;
    const newItems = [];
    for (const { key, value } of items) {
      try {
        const existing = await this._storage.get(key);
        if (existing !== value) {
          await this._storage.put(key, value);
          synced++;
          newItems.push({ key, value });
          this.emit('sync:progress', { sessionId, key, from });
        }
      } catch (e) {
        this.emit('sync:conflict', { sessionId, key, error: e });
      }
    }

    // Notify upper layers so the app UI (Dexie) can be updated
    if (newItems.length > 0) {
      this.emit('items:synced', { from, items: newItems });
    }

    this._completeSession(session, { synced: true, itemsSynced: synced });
  }

  /** @private */
  _completeSession(session, result) {
    clearTimeout(session.timeout);
    this._sessions.delete(session.sessionId);
    this.emit('sync:completed', { sessionId: session.sessionId, peerId: session.peerId, ...result });
    session.resolve(result);
  }

  /** @private */
  async _sendTo(peerId, message) {
    if (typeof this._sendFn === 'function') {
      try { await this._sendFn(peerId, message); } catch (e) { /* swallow */ }
    } else {
      this.emit('send', peerId, message);
    }
  }

  /**
   * Set the send function for outbound messages.
   * @param {Function} fn - (toPeerId, message) => Promise<void>
   */
  setSendFn(fn) {
    this._sendFn = fn;
  }
}
