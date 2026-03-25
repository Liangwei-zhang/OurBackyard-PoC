/**
 * Tests for CellShard — H3 geographic peer management.
 * Run with: node --test sdk/tests/cell-shard.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { CellShard } from '../src/mesh/cell-shard.js';

// Calgary downtown H3 cells (L9 format — 15 hex chars)
const MY_CELL   = '8f283082affffff'; // local node's cell
const NEAR_CELL = '8f283082bffffff'; // same L7 group
const FAR_CELL  = '8f2830821ffffff'; // different area

describe('CellShard — constructor', () => {
  it('should create with required options', () => {
    const cs = new CellShard({ peerId: 'p1', h3Cell: MY_CELL });
    assert.equal(cs.myCell, MY_CELL);
    assert.ok(cs.myL7, 'Should compute L7 cell');
    assert.notEqual(cs.myL7, MY_CELL);
  });

  it('should throw if peerId is missing', () => {
    assert.throws(() => new CellShard({ h3Cell: MY_CELL }), /peerId is required/);
  });

  it('should throw if h3Cell is missing', () => {
    assert.throws(() => new CellShard({ peerId: 'p1' }), /h3Cell is required/);
  });
});

describe('CellShard — addPeer / removePeer', () => {
  let cs;
  beforeEach(() => {
    cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL });
  });

  it('should add a peer to cell tracking', () => {
    cs.addPeer('peer1', MY_CELL);
    assert.equal(cs.getAllPeers().length, 1);
    assert.equal(cs.getPeersInCell(MY_CELL).length, 1);
  });

  it('should ignore self-add', () => {
    cs.addPeer('local', MY_CELL);
    assert.equal(cs.getAllPeers().length, 0);
  });

  it('should ignore addPeer with missing args', () => {
    cs.addPeer(null, MY_CELL);
    cs.addPeer('peer1', null);
    assert.equal(cs.getAllPeers().length, 0);
  });

  it('should remove a peer from tracking', () => {
    cs.addPeer('peer1', MY_CELL);
    cs.removePeer('peer1');
    assert.equal(cs.getAllPeers().length, 0);
    assert.equal(cs.getPeersInCell(MY_CELL).length, 0);
  });

  it('should handle removePeer for unknown peer gracefully', () => {
    assert.doesNotThrow(() => cs.removePeer('nobody'));
  });

  it('should emit cell:joined event on addPeer', (t, done) => {
    cs.on('cell:joined', ({ peerId, cell }) => {
      assert.equal(peerId, 'peer1');
      assert.equal(cell, MY_CELL);
      done();
    });
    cs.addPeer('peer1', MY_CELL);
  });

  it('should emit cell:left event on removePeer', (t, done) => {
    cs.addPeer('peer1', MY_CELL);
    cs.on('cell:left', ({ peerId }) => {
      assert.equal(peerId, 'peer1');
      done();
    });
    cs.removePeer('peer1');
  });
});

describe('CellShard — cell grouping and L7', () => {
  let cs;
  beforeEach(() => {
    cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL });
    cs.addPeer('peer1', MY_CELL);
    cs.addPeer('peer2', NEAR_CELL);
    cs.addPeer('peer3', FAR_CELL);
  });

  it('should correctly track peers in different cells', () => {
    assert.equal(cs.getPeersInCell(MY_CELL).length, 1);
    assert.equal(cs.getPeersInCell(NEAR_CELL).length, 1);
    assert.equal(cs.getPeersInCell(FAR_CELL).length, 1);
    assert.equal(cs.getAllPeers().length, 3);
  });

  it('should compute L7 cells (different from L9)', () => {
    const info = cs.getPeerInfo('peer1');
    assert.ok(info);
    assert.ok(info.l7);
    assert.notEqual(info.l7, info.cell);
  });

  it('should return nearby peers sorted by proximity', () => {
    const nearby = cs.getNearbyPeers(10);
    assert.equal(nearby.length, 3);
    // peer1 is in same cell (proximity 0) should come first
    assert.equal(nearby[0].peerId, 'peer1');
    assert.equal(nearby[0].proximity, 0);
  });
});

describe('CellShard — density management', () => {
  it('should emit cell:split when max peers exceeded', (t, done) => {
    const cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL, maxPeersPerCell: 3 });
    cs.on('cell:split', ({ cell, peerCount }) => {
      assert.equal(cell, MY_CELL);
      assert.ok(peerCount > 3);
      done();
    });
    cs.addPeer('p1', MY_CELL);
    cs.addPeer('p2', MY_CELL);
    cs.addPeer('p3', MY_CELL);
    cs.addPeer('p4', MY_CELL); // triggers split
  });

  it('should return hot cell stats', () => {
    const cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL, hotThreshold: 2 });
    cs.addPeer('p1', MY_CELL);
    cs.addPeer('p2', MY_CELL);
    const stats = cs.getCellStats();
    const myCellStat = stats.find(s => s.cell === MY_CELL);
    assert.ok(myCellStat);
    assert.equal(myCellStat.peerCount, 2);
    assert.equal(myCellStat.isHot, true);
  });
});

describe('CellShard — cell migration', () => {
  it('should update own cell on migrateToCell', () => {
    const cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL });
    cs.migrateToCell(FAR_CELL);
    assert.equal(cs.myCell, FAR_CELL);
  });

  it('should handle peer cell migration (addPeer called again with new cell)', () => {
    const cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL });
    cs.addPeer('peer1', MY_CELL);
    assert.equal(cs.getPeersInCell(MY_CELL).length, 1);
    cs.addPeer('peer1', FAR_CELL); // peer moved
    assert.equal(cs.getPeersInCell(MY_CELL).length, 0);
    assert.equal(cs.getPeersInCell(FAR_CELL).length, 1);
    assert.equal(cs.getAllPeers().length, 1);
  });

  it('should emit cell:joined with migratedFrom on migrateToCell', (t, done) => {
    const cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL });
    cs.on('cell:joined', (data) => {
      if (data.migratedFrom) {
        assert.equal(data.migratedFrom, MY_CELL);
        assert.equal(data.cell, FAR_CELL);
        done();
      }
    });
    cs.migrateToCell(FAR_CELL);
  });
});

describe('CellShard — getCellStats', () => {
  it('should return stats per cell', () => {
    const cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL });
    cs.addPeer('p1', MY_CELL);
    cs.addPeer('p2', MY_CELL);
    cs.addPeer('p3', FAR_CELL);
    const stats = cs.getCellStats();
    assert.equal(stats.length, 2);
    const myStats = stats.find(s => s.cell === MY_CELL);
    assert.equal(myStats.peerCount, 2);
  });
});

describe('CellShard — peers:updated event', () => {
  it('should emit peers:updated on add and remove', () => {
    const cs = new CellShard({ peerId: 'local', h3Cell: MY_CELL });
    let count = 0;
    cs.on('peers:updated', () => count++);
    cs.addPeer('p1', MY_CELL);
    cs.removePeer('p1');
    assert.equal(count, 2);
  });
});
