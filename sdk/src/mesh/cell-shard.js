import { EventBus } from '../event-bus.js';

/**
 * CellShard — Geographic-aware peer management using H3 hexagonal cells.
 *
 * Features:
 *  - H3 L9 cell assignment for each peer (based on geolocation)
 *  - L7 parent cell grouping for cross-cell peer discovery
 *  - Peer density management: max peers per cell, cell splitting when overloaded
 *  - Near-cell priority: prefer peers in adjacent H3 cells
 *  - Cell migration: handle peer movement between cells gracefully
 *  - Hot/cold cell metrics for load balancing
 *
 * Events: 'cell:joined', 'cell:left', 'cell:split', 'peers:updated'
 */
export class CellShard extends EventBus {
  /**
   * @param {object} opts
   * @param {string} opts.peerId - Local peer identifier
   * @param {string} opts.h3Cell - H3 L9 cell hex for this peer
   * @param {number} [opts.maxPeersPerCell=20] - Max peers per L9 cell before triggering split
   * @param {number} [opts.adjacentCellDepth=1] - How many L7-levels up to consider "nearby"
   * @param {number} [opts.hotThreshold=15] - Peer count above which a cell is "hot"
   */
  constructor({ peerId, h3Cell, maxPeersPerCell = 20, adjacentCellDepth = 1, hotThreshold = 15 }) {
    super();
    if (!peerId) throw new TypeError('peerId is required');
    if (!h3Cell) throw new TypeError('h3Cell is required');

    this._peerId = peerId;
    this._myCell = h3Cell;
    this._myL7 = this._toL7(h3Cell);
    this._maxPeersPerCell = maxPeersPerCell;
    this._adjacentCellDepth = adjacentCellDepth;
    this._hotThreshold = hotThreshold;

    /** @type {Map<string, {cell: string, l7: string, connectedAt: number, lastSeen: number}>} */
    this._peers = new Map();
    /** @type {Map<string, Set<string>>} cell → Set<peerId> */
    this._cellPeers = new Map();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Add or update a peer with its H3 cell.
   * Checks density, may trigger 'cell:split' if cell is overloaded.
   * @param {string} peerId
   * @param {string} h3Cell
   */
  addPeer(peerId, h3Cell) {
    if (!peerId || !h3Cell) return;
    if (peerId === this._peerId) return;

    const l7 = this._toL7(h3Cell);
    const now = Date.now();

    // If peer already exists, handle cell migration
    if (this._peers.has(peerId)) {
      const existing = this._peers.get(peerId);
      if (existing.cell !== h3Cell) {
        this._removeFromCell(peerId, existing.cell);
        this.emit('cell:left', { peerId, cell: existing.cell });
      }
    }

    this._peers.set(peerId, { cell: h3Cell, l7, connectedAt: now, lastSeen: now });
    this._addToCell(peerId, h3Cell);

    this.emit('cell:joined', { peerId, cell: h3Cell, l7 });
    this.emit('peers:updated', { peers: this.getAllPeers() });

    // Check density and possibly trigger a split event
    const cellCount = this._getCellCount(h3Cell);
    if (cellCount > this._maxPeersPerCell) {
      this.emit('cell:split', { cell: h3Cell, peerCount: cellCount });
    }
  }

  /**
   * Remove a peer from cell tracking.
   * @param {string} peerId
   */
  removePeer(peerId) {
    if (!peerId) return;
    const info = this._peers.get(peerId);
    if (!info) return;

    this._removeFromCell(peerId, info.cell);
    this._peers.delete(peerId);
    this.emit('cell:left', { peerId, cell: info.cell });
    this.emit('peers:updated', { peers: this.getAllPeers() });
  }

  /**
   * Update last-seen timestamp for a peer.
   * @param {string} peerId
   */
  touchPeer(peerId) {
    const info = this._peers.get(peerId);
    if (info) info.lastSeen = Date.now();
  }

  /**
   * Return all peers in a specific H3 cell.
   * @param {string} cell
   * @returns {string[]} Array of peerIds
   */
  getPeersInCell(cell) {
    const set = this._cellPeers.get(cell);
    return set ? [...set] : [];
  }

  /**
   * Return peers sorted by cell proximity (own cell first, then same L7, then others).
   * @param {number} [maxCount=10]
   * @returns {Array<{peerId: string, cell: string, l7: string, proximity: number}>}
   */
  getNearbyPeers(maxCount = 10) {
    const results = [];
    for (const [peerId, info] of this._peers) {
      const proximity = this._proximityScore(info.cell);
      results.push({ peerId, cell: info.cell, l7: info.l7, proximity });
    }
    // Sort: lower score = closer
    results.sort((a, b) => a.proximity - b.proximity);
    return results.slice(0, maxCount);
  }

  /**
   * Return all tracked peers as an array.
   * @returns {Array<{peerId: string, cell: string, l7: string, connectedAt: number, lastSeen: number}>}
   */
  getAllPeers() {
    const result = [];
    for (const [peerId, info] of this._peers) {
      result.push({ peerId, ...info });
    }
    return result;
  }

  /**
   * Return statistics about each cell.
   * @returns {Array<{cell: string, peerCount: number, isHot: boolean}>}
   */
  getCellStats() {
    const stats = [];
    for (const [cell, peerSet] of this._cellPeers) {
      stats.push({
        cell,
        peerCount: peerSet.size,
        isHot: peerSet.size >= this._hotThreshold,
      });
    }
    return stats;
  }

  /**
   * Migrate this node to a new H3 cell (e.g., the user has moved).
   * Updates own cell and re-evaluates nearby peers.
   * @param {string} newH3Cell
   */
  migrateToCell(newH3Cell) {
    if (!newH3Cell) return;
    const oldCell = this._myCell;
    this._myCell = newH3Cell;
    this._myL7 = this._toL7(newH3Cell);
    this.emit('cell:joined', { peerId: this._peerId, cell: newH3Cell, l7: this._myL7, migratedFrom: oldCell });
    this.emit('peers:updated', { peers: this.getAllPeers() });
  }

  /**
   * Get cell information for a specific peer.
   * @param {string} peerId
   * @returns {{cell: string, l7: string, connectedAt: number, lastSeen: number}|null}
   */
  getPeerInfo(peerId) {
    return this._peers.get(peerId) || null;
  }

  /**
   * Get count of peers in the local node's own cell.
   * @returns {number}
   */
  getLocalCellPeerCount() {
    return this._getCellCount(this._myCell);
  }

  /**
   * Get the local node's current H3 cell.
   * @returns {string}
   */
  get myCell() { return this._myCell; }

  /**
   * Get the local node's current L7 cell.
   * @returns {string}
   */
  get myL7() { return this._myL7; }

  // ── H3 helpers (pure bit manipulation, no h3-js dependency) ──────────────

  /**
   * Convert H3 L9 cell to L7 parent (same logic as NostrSignaling._toL7).
   * @param {string} h3CellHex
   * @returns {string}
   */
  _toL7(h3CellHex) {
    try {
      if (!h3CellHex) return h3CellHex;
      const normalized = String(h3CellHex).padStart(15, '0');
      if (!/^[0-9a-fA-F]{15}$/.test(normalized)) return h3CellHex;
      const cell = BigInt('0x' + normalized);
      // Mask digits 7-14 to 7 (0b111 = filled/unused)
      let digitMask = 0n;
      for (let d = 7; d < 15; d++) {
        const shift = BigInt(44 - d * 3);
        digitMask |= (7n << shift);
      }
      // Set resolution field [55:52] to 7
      const resMask = 0xFn << 52n;
      const l7 = (cell & ~resMask & ~digitMask) | (7n << 52n) | digitMask;
      return l7.toString(16).padStart(15, '0');
    } catch {
      return h3CellHex;
    }
  }

  /**
   * Compute a proximity score between two cells (lower = closer).
   * 0 = same cell, 1 = same L7, 2 = different L7
   * @param {string} cellA
   * @returns {number}
   */
  _proximityScore(cellA) {
    if (cellA === this._myCell) return 0;
    const l7A = this._toL7(cellA);
    if (l7A === this._myL7) return 1;
    return 2;
  }

  /**
   * Compute cell distance (approximate, by comparing L7 prefix).
   * @param {string} cellA
   * @param {string} cellB
   * @returns {number} 0 = same, 1 = same L7, 2 = different L7
   */
  _cellDistance(cellA, cellB) {
    if (cellA === cellB) return 0;
    const l7A = this._toL7(cellA);
    const l7B = this._toL7(cellB);
    return l7A === l7B ? 1 : 2;
  }

  /**
   * Return adjacent cells based on known peer data.
   * "Adjacent" means same L7 parent, different L9 cell.
   * @param {string} cell
   * @returns {string[]} List of distinct cells that are in the same L7 parent
   */
  _getAdjacentCells(cell) {
    const l7 = this._toL7(cell);
    const adjacent = new Set();
    for (const [, info] of this._peers) {
      if (info.l7 === l7 && info.cell !== cell) {
        adjacent.add(info.cell);
      }
    }
    return [...adjacent];
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** @private */
  _addToCell(peerId, cell) {
    if (!this._cellPeers.has(cell)) this._cellPeers.set(cell, new Set());
    this._cellPeers.get(cell).add(peerId);
  }

  /** @private */
  _removeFromCell(peerId, cell) {
    const set = this._cellPeers.get(cell);
    if (!set) return;
    set.delete(peerId);
    if (set.size === 0) this._cellPeers.delete(cell);
  }

  /** @private */
  _getCellCount(cell) {
    const set = this._cellPeers.get(cell);
    return set ? set.size : 0;
  }
}
