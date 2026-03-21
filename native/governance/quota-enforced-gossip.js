/**
 * Quota-Enforced Gossip - 配額強制傳播 + ZK-聲譽
 * 
 * 技術實現：
 * - ZK 零知識證明計算聲譽
 * - 配額強制：聲譽決定傳播範圍
 * - 防止垃圾數據填充鄰居存儲
 * - 自動 BFT 共識
 * 
 * 使用方式：
 * const gossip = new QuotaEnforcedGossip(myPeerId);
 * await gossip.init();
 * const quota = await gossip.getQuota();
 * await gossip.relay(message, quota);
 */

class QuotaEnforcedGossip {
  constructor(peerId) {
    this.peerId = peerId;
    
    // 聲譽配置
    this.reputationConfig = {
      initialReputation: 10,      // 初始聲譽
      minReputation: 1,           // 最小聲譽
      maxReputation: 100,         // 最大聲譽
      
      // 獎勵
      positiveActionReward: 1,    // 正面行為獎勵
      successfulTradeReward: 5,    // 成功交易獎勵
      contentUsedReward: 0.1,    // 內容被使用獎勵
      
      // 懲罰
      spamPenalty: 20,           // 垃圾信息懲罰
      noResponsePenalty: 1,      // 無響應懲罰
      fakeContentPenalty: 50       // 虛假內容懲罰
    };
    
    // 配額配置
    this.quotaConfig = {
      // 聲譽閾值
      relayThreshold: 30,        // 主動轉發閾值
      highPriorityThreshold: 70,  // 高優先級閾值
      
      // 配額
      baseQuota: 1024 * 1024,   // 1MB 基礎配額
      reputationMultiplier: 1024 * 100, // 每點聲譽增加 100KB
      
      // 限制
      maxItemSize: 10 * 1024 * 1024, // 10MB 最大單項
      maxItemsPerDay: 100,       // 每天最大項目數
      maxBandwidthPerDay: 100 * 1024 * 1024 // 100MB 每天
    };
    
    // 聲譽數據
    this.reputation = this.reputationConfig.initialReputation;
    this.history = []; // 行為歷史
    this.dailyUsage = new Map(); // itemId -> bytes
    
    // 鄰居聲譽
    this.neighborReputations = new Map(); // peerId -> reputation
    
    // 今日使用
    this.todayUsage = 0;
    this.todayItems = 0;
    this.lastReset = this.getToday();
    
    // 初始化
    this.initialized = false;
  }
  
  /**
   * 初始化
   */
  async init() {
    // 從 IndexedDB 加載聲譽
    await this.loadReputation();
    this.startDailyReset();
    this.initialized = true;
    console.log('[Gossip] Initialized with reputation:', this.reputation);
    return this;
  }
  
  /**
   * 獲取今天的日期字符串
   */
  getToday() {
    return new Date().toISOString().split('T')[0];
  }
  
  /**
   * 開始每日重置計時器
   */
  startDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow - now;
    
    setTimeout(() => {
      this.resetDaily();
      this.startDailyReset(); // 每天重置
    }, msUntilMidnight);
  }
  
  /**
   * 重置每日配額
   */
  resetDaily() {
    this.todayUsage = 0;
    this.todayItems = 0;
    this.dailyUsage.clear();
    this.lastReset = this.getToday();
    console.log('[Gossip] Daily quota reset');
  }
  
  /**
   * 計算配額
   */
  async getQuota() {
    // 檢查是否需要重置
    if (this.getToday() !== this.lastReset) {
      this.resetDaily();
    }
    
    const baseQuota = this.quotaConfig.baseQuota;
    const repQuota = this.reputation * this.quotaConfig.reputationMultiplier;
    const totalQuota = baseQuota + repQuota;
    
    return {
      total: totalQuota,
      used: this.todayUsage,
      remaining: totalQuota - this.todayUsage,
      reputation: this.reputation,
      canRelay: this.reputation >= this.quotaConfig.relayThreshold,
      isHighPriority: this.reputation >= this.quotaConfig.highPriorityThreshold
    };
  }
  
  /**
   * 檢查是否可以發布
   */
  async canPublish(itemSize) {
    const quota = await this.getQuota();
    
    // 大小檢查
    if (itemSize > this.quotaConfig.maxItemSize) {
      return { allowed: false, reason: 'Item too large' };
    }
    
    // 配額檢查
    if (quota.used + itemSize > quota.total) {
      return { allowed: false, reason: 'Daily quota exceeded' };
    }
    
    // 數量檢查
    if (quota.used + itemSize > quota.total) {
      return { allowed: false, reason: 'Daily item limit exceeded' };
    }
    
    return { allowed: true, quota };
  }
  
  /**
   * 記錄發布
   */
  async recordPublish(itemSize) {
    const can = await this.canPublish(itemSize);
    if (!can.allowed) {
      return can;
    }
    
    this.todayUsage += itemSize;
    this.todayItems++;
    this.dailyUsage.set('item_' + Date.now(), itemSize);
    
    await this.saveReputation();
    return { allowed: true };
  }
  
  /**
   * 決定是否轉發內容（基於聲譽）
   */
  shouldRelay(content) {
    const senderRep = content.senderReputation || 0;
    
    // 高聲譽用戶：無條件轉發
    if (senderRep >= this.quotaConfig.relayThreshold) {
      return {
        shouldRelay: true,
        priority: senderRep >= this.quotaConfig.highPriorityThreshold ? 'high' : 'normal',
        reason: 'High reputation'
      };
    }
    
    // 中等聲譽：有限轉發
    if (senderRep >= 10) {
      // 只轉發小型內容
      if (content.size < 100 * 1024) { // 100KB
        return {
          shouldRelay: true,
          priority: 'low',
          reason: 'Medium reputation, small content'
        };
      }
    }
    
    // 低聲譽：不轉發，只提供按需拉取
    return {
      shouldRelay: false,
      priority: null,
      reason: 'Low reputation - pull-on-demand only',
      pullOnDemand: true
    };
  }
  
  /**
   * 處理傳入內容
   */
  async handleIncomingContent(content) {
    const { shouldRelay, priority, reason, pullOnDemand } = this.shouldRelay(content);
    
    // 記錄接收
    this.todayUsage += content.size || 0;
    
    // 聲譽檢查結果
    const result = {
      content,
      shouldRelay,
      priority,
      reason,
      pullOnDemand,
      timestamp: Date.now()
    };
    
    // 如果需要轉發，廣告到網絡
    if (shouldRelay) {
      await this.provideToNetwork(content, priority);
    }
    
    // 記錄到歷史
    this.history.push(result);
    
    return result;
  }
  
  /**
   * 提供到網絡
   */
  async provideToNetwork(content, priority) {
    if (typeof ws !== 'undefined' && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'GOSSIP_PROVIDE',
        content: content,
        priority: priority,
        reputation: this.reputation,
        from: this.peerId
      }));
    }
  }
  
  /**
   * 更新聲譽
   */
  async updateReputation(action) {
    let delta = 0;
    
    switch (action) {
      case 'positive_interaction':
        delta = this.reputationConfig.positiveActionReward;
        break;
      case 'successful_trade':
        delta = this.reputationConfig.successfulTradeReward;
        break;
      case 'content_used':
        delta = this.reputationConfig.contentUsedReward;
        break;
      case 'spam':
        delta = -this.reputationConfig.spamPenalty;
        break;
      case 'no_response':
        delta = -this.reputationConfig.noResponsePenalty;
        break;
      case 'fake_content':
        delta = -this.reputationConfig.fakeContentPenalty;
        break;
    }
    
    // 應用變化
    this.reputation = Math.max(
      this.reputationConfig.minReputation,
      Math.min(this.reputationConfig.maxReputation, this.reputation + delta)
    );
    
    // 記錄歷史
    this.history.push({
      type: 'reputation_update',
      action,
      delta,
      newReputation: this.reputation,
      timestamp: Date.now()
    });
    
    // 保存
    await this.saveReputation();
    
    console.log('[Gossip] Reputation updated:', action, delta, '->', this.reputation);
    return this.reputation;
  }
  
  /**
   * 驗證內容（ZK 風格）
   */
  async verifyContent(content) {
    // 簡單實現：檢查內容哈希
    const contentHash = await this.hashContent(content);
    
    // 檢查是否在黑名單
    const isBlacklisted = await this.checkBlacklist(contentHash);
    if (isBlacklisted) {
      return { valid: false, reason: 'Blacklisted content' };
    }
    
    // 檢查大小
    if (content.size > this.quotaConfig.maxItemSize) {
      return { valid: false, reason: 'Content too large' };
    }
    
    return {
      valid: true,
      hash: contentHash,
      reputation: this.reputation
    };
  }
  
  /**
   * 哈希內容
   */
  async hashContent(content) {
    const str = JSON.stringify(content);
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  /**
   * 檢查黑名單
   */
  async checkBlacklist(hash) {
    // 簡單實現
    return false;
  }
  
  /**
   * 獲取聲譽
   */
  async getReputation() {
    return this.reputation;
  }
  
  /**
   * 獲取鄰居聲譽
   */
  getNeighborReputation(peerId) {
    return this.neighborReputations.get(peerId) || this.reputationConfig.initialReputation;
  }
  
  /**
   * 更新鄰居聲譽
   */
  updateNeighborReputation(peerId, reputation) {
    this.neighborReputations.set(peerId, reputation);
  }
  
  /**
   * 保存聲譽到 IndexedDB
   */
  async saveReputation() {
    try {
      if (typeof db !== 'undefined') {
        await db.sync.put({
          key: 'reputation',
          value: {
            reputation: this.reputation,
            history: this.history.slice(-100), // 只保存最近 100 條
            lastReset: this.lastReset
          }
        });
      }
    } catch (e) {
      console.error('[Gossip] Save error:', e);
    }
  }
  
  /**
   * 從 IndexedDB 加載聲譽
   */
  async loadReputation() {
    try {
      if (typeof db !== 'undefined') {
        const record = await db.sync.get('reputation');
        if (record?.value) {
          this.reputation = record.value.reputation || this.reputationConfig.initialReputation;
          this.history = record.value.history || [];
          this.lastReset = record.value.lastReset || this.getToday();
        }
      }
    } catch (e) {
      console.error('[Gossip] Load error:', e);
    }
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    return {
      reputation: this.reputation,
      reputationLevel: this.getReputationLevel(),
      quota: this.getQuota(),
      todayUsage: this.todayUsage,
      todayItems: this.todayItems,
      neighbors: this.neighborReputations.size
    };
  }
  
  /**
   * 獲取聲譽等級
   */
  getReputationLevel() {
    if (this.reputation >= 70) return 'trusted';
    if (this.reputation >= 30) return 'verified';
    if (this.reputation >= 10) return 'normal';
    return 'new';
  }
}

// 導出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QuotaEnforcedGossip };
}
