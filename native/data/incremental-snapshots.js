/**
 * Incremental Snapshots - 增量狀態快照
 * 
 * 替代完整遞歸 SNARK，實現「恆定時間同步」的簡化方案
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash, randomBytes } = require('crypto');

// 簡化的 Merkle Patricia Trie
class MerklePatriciaTrie {
  constructor() {
    this.root = null;
    this.nodes = new Map();
  }
  
  put(key, value) {
    const nodeId = createHash('sha256').update(key).digest('hex').slice(0, 16);
    this.nodes.set(nodeId, { key, value, children: [] });
    this.root = nodeId;
    return nodeId;
  }
  
  get(key) {
    const nodeId = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return this.nodes.get(nodeId)?.value;
  }
  
  getRootHash() {
    if (!this.root) return createHash('sha256').digest('hex');
    return this.root;
  }
  
  generateProof(key) {
    // 簡化的證明生成
    return { key, root: this.root };
  }
}

class IncrementalSnapshots extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // 配置
    this.config = {
      snapshotInterval: options.snapshotInterval || 300000, // 5分鐘
      retentionPeriod: options.retentionPeriod || 2592000000, // 30天
      maxSnapshots: options.maxSnapshots || 1000,
      proofCompressionLevel: options.proofCompressionLevel || 9,
      
      // 狀態類型
      stateTypes: ['reputation', 'credits', 'listings', 'transactions']
    };
    
    // 狀態存儲
    this.state = {
      reputation: new MerklePatriciaTrie(),
      credits: new MerklePatriciaTrie(),
      listings: new MerklePatriciaTrie(),
      transactions: new MerklePatriciaTrie()
    };
    
    // 快照歷史
    this.snapshots = new Map();
    
    // 待處理變更隊列
    this.pendingChanges = [];
    
    // 當前快照索引
    this.currentSnapshotIndex = 0;
    
    // 定時器
    this.snapshotTimer = null;
  }
  
  /**
   * 初始化狀態
   * @param {Object} initialState - 初始狀態
   */
  initialize(initialState) {
    for (const [type, data] of Object.entries(initialState)) {
      if (this.state[type]) {
        for (const [key, value] of Object.entries(data)) {
          this.state[type].put(key, value);
        }
      }
    }
    
    // 生成初始快照
    this._createSnapshot('initial');
    
    console.log('[Snapshots] State initialized');
  }
  
  /**
   * 更新狀態
   * @param {string} type - 狀態類型
   * @param {string} key - 鍵
   * @param {any} value - 值
   */
  updateState(type, key, value) {
    if (!this.state[type]) {
      throw new Error(`Unknown state type: ${type}`);
    }
    
    // 更新狀態
    this.state[type].put(key, value);
    
    // 記錄變更
    this.pendingChanges.push({
      type,
      key,
      value,
      timestamp: Date.now()
    });
    
    this.emit('state:update', { type, key, value });
  }
  
  /**
   * 批量更新狀態
   * @param {Array} changes - 變更數組
   */
  batchUpdate(changes) {
    for (const change of changes) {
      this.updateState(change.type, change.key, change.value);
    }
  }
  
  /**
   * 創建快照
   * @param {string} label - 快照標籤
   */
  _createSnapshot(label = 'periodic') {
    const timestamp = Date.now();
    
    // 計算所有狀態的根哈希
    const stateRoots = {};
    for (const [type, trie] of Object.entries(this.state)) {
      stateRoots[type] = trie.getRootHash();
    }
    
    // 生成總根哈希
    const totalRoot = createHash('sha256')
      .update(JSON.stringify(stateRoots))
      .digest('hex');
    
    // 壓縮變更歷史
    const compressedChanges = this._compressChanges(this.pendingChanges);
    
    // 生成增量證明
    const proof = this._generateProof(stateRoots, timestamp);
    
    const snapshot = {
      index: this.currentSnapshotIndex++,
      label,
      timestamp,
      stateRoots,
      totalRoot,
      changes: this.pendingChanges.length,
      compressedChanges,
      proof,
      size: this._estimateSize(stateRoots, compressedChanges)
    };
    
    // 存儲快照
    this.snapshots.set(snapshot.index, snapshot);
    
    // 清理待處理
    this.pendingChanges = [];
    
    // 修剪舊快照
    this._pruneOldSnapshots();
    
    console.log(`[Snapshots] Created snapshot #${snapshot.index} (${snapshot.label}), size: ${snapshot.size} bytes`);
    
    this.emit('snapshot:created', snapshot);
    
    return snapshot;
  }
  
  /**
   * 壓縮變更歷史
   */
  _compressChanges(changes) {
    if (changes.length === 0) return [];
    
    // 簡單壓縮: 按類型分組
    const grouped = {};
    
    for (const change of changes) {
      if (!grouped[change.type]) {
        grouped[change.type] = [];
      }
      grouped[change.type].push({
        k: change.key,
        v: change.value,
        t: change.timestamp
      });
    }
    
    return grouped;
  }
  
  /**
   * 生成證明
   */
  _generateProof(stateRoots, timestamp) {
    // 簡化的 ZK 風格證明
    const proofData = {
      stateRoots,
      timestamp,
      nonce: randomBytes(16).toString('hex'),
      commitment: createHash('sha256')
        .update(JSON.stringify(stateRoots) + timestamp)
        .digest('hex')
    };
    
    return {
      commitment: proofData.commitment,
      timestamp: proofData.timestamp,
      // 簡化: 實際需要完整的 ZK 電路
      verified: true
    };
  }
  
  /**
   * 估計大小
   */
  _estimateSize(stateRoots, compressedChanges) {
    const stateSize = JSON.stringify(stateRoots).length;
    const changesSize = JSON.stringify(compressedChanges).length;
    const proofSize = 256; // 假設證明大小
    
    return stateSize + changesSize + proofSize;
  }
  
  /**
   * 修剪舊快照
   */
  _pruneOldSnapshots() {
    // 保留最近的快照
    const indices = Array.from(this.snapshots.keys()).sort((a, b) => a - b);
    
    while (indices.length > this.config.maxSnapshots) {
      const oldest = indices.shift();
      this.snapshots.delete(oldest);
    }
    
    // 清理過期快照
    const cutoff = Date.now() - this.config.retentionPeriod;
    for (const [index, snapshot] of this.snapshots) {
      if (snapshot.timestamp < cutoff) {
        this.snapshots.delete(index);
      }
    }
  }
  
  /**
   * 獲取最新快照
   */
  getLatestSnapshot() {
    const indices = Array.from(this.snapshots.keys()).sort((a, b) => b - a);
    if (indices.length === 0) return null;
    return this.snapshots.get(indices[0]);
  }
  
  /**
   * 獲取快照證明
   * @param {number} index - 快照索引
   */
  getSnapshotProof(index) {
    const snapshot = this.snapshots.get(index);
    if (!snapshot) return null;
    
    return {
      index: snapshot.index,
      timestamp: snapshot.timestamp,
      totalRoot: snapshot.totalRoot,
      proof: snapshot.proof,
      size: snapshot.size
    };
  }
  
  /**
   * 驗證快照
   * @param {number} index - 快照索引
   */
  verifySnapshot(index) {
    const snapshot = this.snapshots.get(index);
    if (!snapshot) return { valid: false, reason: 'Not found' };
    
    // 重新計算根哈希
    const currentRoots = {};
    for (const [type, trie] of Object.entries(this.state)) {
      currentRoots[type] = trie.getRootHash();
    }
    
    const recalculated = createHash('sha256')
      .update(JSON.stringify(currentRoots))
      .digest('hex');
    
    // 驗證
    const valid = recalculated === snapshot.totalRoot;
    
    return {
      valid,
      index: snapshot.index,
      expectedRoot: snapshot.totalRoot,
      actualRoot: recalculated,
      timestamp: snapshot.timestamp
    };
  }
  
  /**
   * 同步到新節點
   * @param {number} fromIndex - 從哪個快照開始
   */
  syncToPeer(fromIndex = 0) {
    const syncData = {
      snapshots: [],
      currentState: {}
    };
    
    // 收集需要的快照
    for (const [index, snapshot] of this.snapshots) {
      if (index >= fromIndex) {
        syncData.snapshots.push({
          index: snapshot.index,
          timestamp: snapshot.timestamp,
          totalRoot: snapshot.totalRoot,
          proof: snapshot.proof,
          compressedChanges: snapshot.compressedChanges
        });
      }
    }
    
    // 收集當前狀態根
    for (const [type, trie] of Object.entries(this.state)) {
      syncData.currentState[type] = trie.getRootHash();
    }
    
    const totalSize = syncData.snapshots.reduce((s, snap) => s + snap.size, 0);
    
    console.log(`[Snapshots] Sync data prepared: ${syncData.snapshots.length} snapshots, ~${totalSize} bytes`);
    
    return {
      snapshotCount: syncData.snapshots.length,
      estimatedSize: totalSize,
      fromIndex,
      data: syncData
    };
  }
  
  /**
   * 從同步數據恢復
   * @param {Object} syncData - 同步數據
   */
  async restoreFromSync(syncData) {
    // 應用快照
    for (const snapshot of syncData.snapshots) {
      await this._applySnapshot(snapshot);
    }
    
    // 驗證
    const latest = this.getLatestSnapshot();
    const currentRoots = {};
    for (const [type, trie] of Object.entries(this.state)) {
      currentRoots[type] = trie.getRootHash();
    }
    
    const valid = latest && latest.totalRoot === createHash('sha256')
      .update(JSON.stringify(currentRoots))
      .digest('hex');
    
    console.log(`[Snapshots] Restored from sync, valid: ${valid}`);
    
    return { restored: true, valid };
  }
  
  /**
   * 應用快照
   */
  async _applySnapshot(snapshot) {
    // 應用壓縮的變更
    if (snapshot.compressedChanges) {
      for (const [type, changes] of Object.entries(snapshot.compressedChanges)) {
        for (const change of changes) {
          this.state[type].put(change.k, change.v);
        }
      }
    }
    
    // 存儲快照
    this.snapshots.set(snapshot.index, snapshot);
    this.currentSnapshotIndex = Math.max(this.currentSnapshotIndex, snapshot.index + 1);
  }
  
  /**
   * 生成狀態轉換證明
   * @param {number} fromIndex - 起始快照
   * @param {number} toIndex - 結束快照
   */
  proveStateTransition(fromIndex, toIndex) {
    const from = this.snapshots.get(fromIndex);
    const to = this.snapshots.get(toIndex);
    
    if (!from || !to) {
      throw new Error('Snapshot not found');
    }
    
    // 簡化的狀態轉換證明
    const proof = {
      from: {
        index: from.index,
        root: from.totalRoot,
        timestamp: from.timestamp
      },
      to: {
        index: to.index,
        root: to.totalRoot,
        timestamp: to.timestamp
      },
      transition: {
        changes: to.changes,
        verified: true
      },
      commitment: createHash('sha256')
        .update(from.totalRoot + to.totalRoot + to.changes)
        .digest('hex')
    };
    
    return proof;
  }
  
  /**
   * 啟動定時快照
   */
  startPeriodicSnapshots() {
    this.snapshotTimer = setInterval(() => {
      this._createSnapshot('periodic');
    }, this.config.snapshotInterval);
    
    console.log(`[Snapshots] Periodic snapshots started, interval: ${this.config.snapshotInterval}ms`);
  }
  
  /**
   * 停止定時快照
   */
  stopPeriodicSnapshots() {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
      console.log('[Snapshots] Periodic snapshots stopped');
    }
  }
  
  /**
   * 獲取狀態摘要
   */
  getStateSummary() {
    const summary = {};
    
    for (const [type, trie] of Object.entries(this.state)) {
      summary[type] = {
        root: trie.getRootHash(),
        nodeCount: trie.nodes.size
      };
    }
    
    return summary;
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    return {
      snapshotCount: this.snapshots.size,
      currentIndex: this.currentSnapshotIndex,
      pendingChanges: this.pendingChanges.length,
      latestSnapshot: this.getLatestSnapshot()?.index || null,
      oldestSnapshot: Array.from(this.snapshots.keys())[0] || null,
      estimatedStateSize: this._estimateSize(
        Object.fromEntries(
          Object.entries(this.state).map(([k, v]) => [k, v.getRootHash()])
        ),
        []
      )
    };
  }
}

module.exports = { IncrementalSnapshots };
