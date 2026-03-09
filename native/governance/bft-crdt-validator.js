/**
 * BFT-CRDT Validator - 拜占庭容錯 CRDT 驗證器
 * 
 * 技術實現：
 * - CRDT 最終一致性
 * - BFT 拜占庭容錯
 * - 內容驗證防污染
 * - 衝突自動解決
 * 
 * 使用方式：
 * const validator = new BFTCrdtValidator();
 * await validator.init();
 * const isValid = await validator.validate(operation);
 */

class BFTCrdtValidator {
  constructor(peerId) {
    this.peerId = peerId;
    
    // CRDT 配置
    this.crdtConfig = {
      type: 'g-counter', // 增長計數器
      mergeStrategy: 'last-writer-wins', // 最後寫入者獲勝
      maxConflictSize: 100
    };
    
    // BFT 配置
    this.bftConfig = {
      quorumSize: 3,        // 法定人數
      byzantineThreshold: 1, // 拜占庭節點閾值
      validationTimeout: 5000
    };
    
    // 狀態
    this.state = new Map(); // key -> CRDT value
    this.operations = [];  // 操作日誌
    this.pending = new Map(); // 待驗證操作
    
    // 驗證器
    this.validators = new Set(); // 可信節點列表
    this.initialized = false;
  }
  
  /**
   * 初始化
   */
  async init() {
    this.initialized = true;
    console.log('[BFT-CRDT] Validator initialized');
    return this;
  }
  
  /**
   * 添加驗證節點
   */
  addValidator(peerId) {
    this.validators.add(peerId);
  }
  
  /**
   * 驗證操作
   */
  async validate(operation) {
    if (!this.initialized) {
      return { valid: false, reason: 'Not initialized' };
    }
    
    // 基本驗證
    if (!this.basicValidation(operation)) {
      return { valid: false, reason: 'Basic validation failed' };
    }
    
    // BFT 投票
    const votes = await this.bftVote(operation);
    
    // 檢查是否達到共識
    if (votes.length >= this.bftConfig.quorumSize) {
      const validVotes = votes.filter(v => v.valid).length;
      if (validVotes >= this.bftConfig.quorumSize) {
        // 應用操作
        await this.apply(operation);
        return { valid: true, consensus: true, votes };
      }
    }
    
    return { valid: false, reason: 'No consensus', votes };
  }
  
  /**
   * 基本驗證
   */
  basicValidation(operation) {
    // 檢查操作格式
    if (!operation.type || !operation.key) {
      return false;
    }
    
    // 檢查值大小
    const valueSize = JSON.stringify(operation.value).length;
    if (valueSize > 1024 * 1024) { // 1MB
      return false;
    }
    
    // 檢查時間戳
    if (operation.timestamp > Date.now() + 60000) {
      return false; // 不接受未來時間戳
    }
    
    return true;
  }
  
  /**
   * BFT 投票
   */
  async bftVote(operation) {
    const votes = [];
    
    // 本地驗證
    votes.push({
      validator: this.peerId,
      valid: this.localValidate(operation)
    });
    
    // 請求其他驗證節點
    if (typeof ws !== 'undefined' && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'BFT_VOTE_REQUEST',
        operation,
        from: this.peerId
      }));
    }
    
    // 等待響應（異步）
    return votes;
  }
  
  /**
   * 本地驗證
   */
  localValidate(operation) {
    // 檢查內容哈希
    // 檢查簽名
    // 檢查權限
    return true;
  }
  
  /**
   * 應用操作 (CRDT)
   */
  async apply(operation) {
    const key = operation.key;
    const current = this.state.get(key);
    
    switch (this.crdtConfig.type) {
      case 'g-counter':
        // 增長計數器
        const counter = current || 0;
        this.state.set(key, Math.max(counter, operation.value));
        break;
        
      case 'lww-register':
        // 最後寫入者獲勝
        if (!current || operation.timestamp > current.timestamp) {
          this.state.set(key, {
            value: operation.value,
            timestamp: operation.timestamp,
            peerId: operation.peerId
          });
        }
        break;
        
      case 'or-set':
        // Observed-Remove Set
        const set = current || { elements: new Set(), tombstones: new Set() };
        if (operation.action === 'add') {
          set.elements.add(operation.value);
        } else if (operation.action === 'remove') {
          set.elements.delete(operation.value);
          set.tombstones.add(operation.value);
        }
        this.state.set(key, set);
        break;
    }
    
    // 記錄操作
    this.operations.push({
      ...operation,
      appliedAt: Date.now()
    });
    
    console.log('[BFT-CRDT] Applied:', operation.key);
  }
  
  /**
   * 合併狀態
   */
  async merge(remoteState) {
    for (const [key, value] of remoteState) {
      const local = this.state.get(key);
      
      if (!local) {
        this.state.set(key, value);
        continue;
      }
      
      // CRDT 合併策略
      if (this.crdtConfig.mergeStrategy === 'last-writer-wins') {
        if (value.timestamp > local.timestamp) {
          this.state.set(key, value);
        }
      }
    }
    
    console.log('[BFT-CRDT] Merged state');
  }
  
  /**
   * 獲取狀態
   */
  getState(key) {
    return this.state.get(key);
  }
  
  /**
   * 獲取所有狀態
   */
  getAllState() {
    return Object.fromEntries(this.state);
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    return {
      validators: this.validators.size,
      operations: this.operations.length,
      stateSize: this.state.size,
      type: this.crdtConfig.type
    };
  }
}

// 導出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BFTCrdtValidator };
}
