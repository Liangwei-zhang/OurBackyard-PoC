/**
 * Dynamic Relay Selection - 動態中繼選取
 * 
 * 基於 WoT/ZK Reputation 的智能中繼節點選擇
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');

class DynamicRelaySelection extends EventEmitter {
  constructor(libp2p, options = {}) {
    super();
    this.libp2p = libp2p;
    this.peerId = libp2p.peerId?.toString() || 'unknown';
    
    // 配置
    this.config = {
      // 評分權重
      weightReputation: options.weightReputation || 0.4,
      weightLatency: options.weightLatency || 0.3,
      weightCapacity: options.weightCapacity || 0.2,
      weightUptime: options.weightUptime || 0.1,
      
      // 閾值
      minReputation: options.minReputation || 30,
      maxLatency: options.maxLatency || 500, // ms
      minCapacity: options.minCapacity || 10,
      
      // 監控
      monitorInterval: options.monitorInterval || 60000, // 1分鐘
      healthCheckTimeout: options.healthCheckTimeout || 5000
    };
    
    // 中繼節點註冊表
    this.relayNodes = new Map();
    
    // 延遲歷史
    this.latencyHistory = new Map();
    
    // 連接度量
    this.connectionMetrics = new Map();
    
    // 定時器
    this.monitorTimer = null;
  }
  
  /**
   * 註冊中繼節點
   * @param {string} relayId - 中繼 ID
   * @param {Object} info - 節點信息
   */
  registerRelay(relayId, info) {
    const relay = {
      peerId: relayId,
      reputation: info.reputation || 50,
      capacity: info.capacity || 50, // 連接容量
      uptime: info.uptime || 100, // %
      location: info.location || null,
      lastSeen: Date.now(),
      addedAt: Date.now(),
      status: 'active'
    };
    
    this.relayNodes.set(relayId, relay);
    this.latencyHistory.set(relayId, []);
    
    console.log(`[RelaySel] Registered relay: ${relayId}, reputation: ${relay.reputation}`);
    
    return relay;
  }
  
  /**
   * 選擇最佳中繼
   * @param {Object} options - 選項
   */
  selectBestRelay(options = {}) {
    const candidates = [];
    
    for (const [relayId, relay] of this.relayNodes) {
      // 過濾不合格中繼
      if (!this._isEligible(relay, options)) continue;
      
      // 計算綜合分數
      const score = this._calculateScore(relay, options.preferLocal);
      
      candidates.push({
        relayId,
        relay,
        score,
        latency: this._getAverageLatency(relayId)
      });
    }
    
    if (candidates.length === 0) {
      console.warn('[RelaySel] No eligible relays found');
      return null;
    }
    
    // 按分數排序
    candidates.sort((a, b) => b.score - a.score);
    
    const selected = candidates[0];
    
    console.log(`[RelaySel] Selected relay: ${selected.relayId}, score: ${selected.score.toFixed(2)}`);
    
    return selected;
  }
  
  /**
   * 檢查中繼是否合格
   */
  _isEligible(relay, options = {}) {
    // 檢查基本條件
    if (relay.status !== 'active') return false;
    if (relay.reputation < this.config.minReputation) return false;
    if (relay.capacity < this.config.minCapacity) return false;
    
    // 檢查延遲
    const avgLatency = this._getAverageLatency(relay.peerId);
    if (avgLatency > this.config.maxLatency && avgLatency !== 0) return false;
    
    // 位置偏好
    if (options.preferLocal && options.userLocation && relay.location) {
      const distance = this._calculateDistance(options.userLocation, relay.location);
      if (distance > 50) return false; // 超過50km
    }
    
    return true;
  }
  
  /**
   * 計算綜合分數
   */
  _calculateScore(relay, preferLocal = false) {
    // 聲譽分數 (0-1)
    const reputationScore = Math.min(1, relay.reputation / 100);
    
    // 延遲分數 (0-1, 越低越好)
    const avgLatency = this._getAverageLatency(relay.peerId);
    const latencyScore = avgLatency === 0 ? 1 : Math.max(0, 1 - avgLatency / this.config.maxLatency);
    
    // 容量分數 (0-1)
    const capacityScore = Math.min(1, relay.capacity / 100);
    
    // 正常運行時間分數 (0-1)
    const uptimeScore = relay.uptime / 100;
    
    // 計算加權分數
    let totalScore = (
      reputationScore * this.config.weightReputation +
      latencyScore * this.config.weightLatency +
      capacityScore * this.config.weightCapacity +
      uptimeScore * this.config.weightUptime
    );
    
    // 本地偏好加成
    if (preferLocal && relay.location) {
      totalScore *= 1.2;
    }
    
    return totalScore;
  }
  
  /**
   * 獲取平均延遲
   */
  _getAverageLatency(relayId) {
    const history = this.latencyHistory.get(relayId) || [];
    if (history.length === 0) return 0;
    
    const recent = history.slice(-10);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }
  
  /**
   * 記錄延遲
   */
  recordLatency(relayId, latency) {
    if (!this.latencyHistory.has(relayId)) {
      this.latencyHistory.set(relayId, []);
    }
    
    const history = this.latencyHistory.get(relayId);
    history.push(latency);
    
    // 保持歷史長度
    if (history.length > 100) {
      history.shift();
    }
  }
  
  /**
   * 計算距離
   */
  _calculateDistance(loc1, loc2) {
    const R = 6371;
    const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
    const dLon = (loc2.lng - loc1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) ** 2 +
              Math.cos(loc1.lat * Math.PI / 180) * Math.cos(loc2.lat * Math.PI / 180) *
              Math.sin(dLon/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  
  /**
   * 更新中繼狀態
   */
  updateRelayStatus(relayId, status) {
    const relay = this.relayNodes.get(relayId);
    if (relay) {
      relay.status = status;
      relay.lastSeen = Date.now();
    }
  }
  
  /**
   * 處理中繼故障
   */
  handleRelayFailure(relayId) {
    const relay = this.relayNodes.get(relayId);
    if (relay) {
      // 降低聲譽
      relay.reputation = Math.max(0, relay.reputation - 10);
      relay.capacity = Math.max(0, relay.capacity - 5);
      
      console.warn(`[RelaySel] Relay ${relayId} failed, reputation: ${relay.reputation}`);
      
      // 如果聲譽過低，標記為不活躍
      if (relay.reputation < this.config.minReputation) {
        relay.status = 'inactive';
      }
      
      this.emit('relay:failure', { relayId, reputation: relay.reputation });
    }
  }
  
  /**
   * 處理成功連接
   */
  handleSuccess(relayId) {
    const relay = this.relayNodes.get(relayId);
    if (relay) {
      // 提升聲譽
      relay.reputation = Math.min(100, relay.reputation + 2);
      relay.capacity = Math.min(100, relay.capacity + 1);
      
      this.emit('relay:success', { relayId, reputation: relay.reputation });
    }
  }
  
  /**
   * 開始監控
   */
  startMonitoring() {
    this.monitorTimer = setInterval(() => {
      this._monitorRelays();
    }, this.config.monitorInterval);
    
    console.log('[RelaySel] Started monitoring relays');
  }
  
  /**
   * 監控中繼
   */
  async _monitorRelays() {
    for (const [relayId, relay] of this.relayNodes) {
      if (relay.status !== 'active') continue;
      
      // 健康檢查
      try {
        const latency = await this._healthCheck(relayId);
        this.recordLatency(relayId, latency);
        
        // 更新運行時間
        relay.uptime = Math.min(100, relay.uptime + 0.1);
        
      } catch (e) {
        this.handleRelayFailure(relayId);
      }
    }
  }
  
  /**
   * 健康檢查
   */
  async _healthCheck(relayId) {
    const start = Date.now();
    
    // 模擬 ping
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
    
    return Date.now() - start;
  }
  
  /**
   * 停止監控
   */
  stopMonitoring() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }
  
  /**
   * 獲取中繼列表
   */
  getRelays() {
    return Array.from(this.relayNodes.values())
      .map(r => ({
        peerId: r.peerId,
        reputation: r.reputation,
        score: this._calculateScore(r),
        latency: this._getAverageLatency(r.peerId),
        status: r.status
      }))
      .sort((a, b) => b.score - a.score);
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    const relays = this.getRelays();
    return {
      total: relays.length,
      active: relays.filter(r => r.status === 'active').length,
      avgReputation: relays.length > 0 
        ? relays.reduce((s, r) => s + r.reputation, 0) / relays.length 
        : 0,
      avgLatency: relays.length > 0
        ? relays.reduce((s, r) => s + (r.latency || 0), 0) / relays.length
        : 0
    };
  }
}

module.exports = { DynamicRelaySelection };
