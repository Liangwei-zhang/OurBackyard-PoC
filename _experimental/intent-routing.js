/**
 * Intent-Based Routing (IBR) - 意圖導向路由
 * 
 * 將信息匹配從「等用戶找」轉變為「數據自動流向需求端」
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash } = require('crypto');

class IntentBasedRouting extends EventEmitter {
  constructor(libp2p, options = {}) {
    super();
    this.libp2p = libp2p;
    this.peerId = libp2p.peerId.toString();
    
    // 配置
    this.config = {
      intentVectorDim: options.intentVectorDim || 64,
      gossipWeight: options.gossipWeight || 0.7,
      propagationDepth: options.propagationDepth || 3,
      intentTTL: options.intentTTL || 3600000 // 1小時
    };
    
    // 意圖向量表
    this.intentTable = new Map();
    
    // 意圖傳播權重圖
    this.weightGraph = new Map();
    
    // 待處理的意圖隊列
    this.pendingIntents = [];
    
    // 統計
    this.stats = {
      intentsRegistered: 0,
      intentsFulfilled: 0,
      avgMatchTime: 0
    };
  }
  
  /**
   * 註冊意圖向量
   * @param {string} intentType - 意圖類型 (如 "need:snowblower", "offer:bike")
   * @param {Object} intentData - 意圖數據
   */
  async registerIntent(intentType, intentData) {
    // 生成意圖向量
    const intentVector = this._generateIntentVector(intentType, intentData);
    
    const intent = {
      id: createHash('sha256').update(Date.now() + this.peerId).digest('hex').slice(0, 16),
      type: intentType,
      peerId: this.peerId,
      vector: intentVector,
      data: intentData,
      timestamp: Date.now(),
      ttl: this.config.intentTTL,
      urgency: intentData.urgency || 'normal', // normal, high, critical
      location: intentData.location || null
    };
    
    // 存入本地表
    this.intentTable.set(intent.id, intent);
    this.stats.intentsRegistered++;
    
    // 廣播意圖向量
    await this._broadcastIntent(intent);
    
    // 嘗試立即匹配
    await this._matchIntent(intent);
    
    console.log(`[IBR] Registered intent: ${intentType}, urgency: ${intent.urgency}`);
    
    return intent;
  }
  
  /**
   * 生成意圖向量
   */
  _generateIntentVector(type, data) {
    // 結合類型、關鍵詞、緊急度生成向量
    const combined = `${type}:${data.keywords?.join(':')}:${data.urgency}:${data.priceRange}`;
    const hash = createHash('sha256').update(combined).digest();
    
    // 轉為固定維度向量
    const vector = [];
    for (let i = 0; i < this.config.intentVectorDim; i++) {
      vector.push(hash[i % hash.length] / 255);
    }
    
    // 緊急度權重
    const urgencyWeights = { critical: 1.5, high: 1.2, normal: 1.0 };
    const urgency = urgencyWeights[data.urgency] || 1.0;
    
    return vector.map(v => v * urgency);
  }
  
  /**
   * 廣播意圖向量
   */
  async _broadcastIntent(intent) {
    // 根據意圖類型計算傳播權重
    const weight = this._calculatePropagationWeight(intent);
    
    // 存入權重圖
    if (!this.weightGraph.has(intent.type)) {
      this.weightGraph.set(intent.type, new Map());
    }
    this.weightGraph.get(intent.type).set(this.peerId, weight);
    
    // 通過 GossipSub 廣播
    // 實際實現通過 libp2p 的 pubsub
    this.emit('intent:broadcast', {
      intent: {
        id: intent.id,
        type: intent.type,
        vector: intent.vector,
        location: intent.location,
        urgency: intent.urgency
      },
      propagationWeight: weight,
      depth: this.config.propagationDepth
    });
  }
  
  /**
   * 計算傳播權重
   */
  _calculatePropagationWeight(intent) {
    // 緊急度越高，傳播越廣
    const urgencyWeights = { critical: 1.0, high: 0.8, normal: 0.5 };
    const baseWeight = urgencyWeights[intent.urgency] || 0.5;
    
    // 價格範圍越大，傳播越廣
    const priceRange = intent.data.priceRange || [0, 1000];
    const rangeFactor = (priceRange[1] - priceRange[0]) / 1000;
    
    return Math.min(1.0, baseWeight + rangeFactor * 0.3);
  }
  
  /**
   * 匹配意圖
   */
  async _matchIntent(intent) {
    const startTime = Date.now();
    
    // 查找互補意圖
    const complementaryTypes = this._getComplementaryTypes(intent.type);
    const matches = [];
    
    for (const [otherId, otherIntent] of this.intentTable) {
      if (otherIntent.peerId === this.peerId) continue;
      if (!complementaryTypes.includes(otherIntent.type)) continue;
      
      // 計算向量相似度
      const similarity = this._cosineSimilarity(intent.vector, otherIntent.vector);
      
      // 檢查位置兼容性
      if (intent.location && otherIntent.location) {
        const distance = this._calculateDistance(intent.location, otherIntent.location);
        if (distance > 50) continue; // 超過50km不匹配
      }
      
      if (similarity > 0.7) {
        matches.push({
          intent: otherIntent,
          similarity,
          distance: intent.location && otherIntent.location 
            ? this._calculateDistance(intent.location, otherIntent.location)
            : null
        });
      }
    }
    
    // 按相似度排序
    matches.sort((a, b) => b.similarity - a.similarity);
    
    if (matches.length > 0) {
      const bestMatch = matches[0];
      
      // 觸發匹配事件
      this.emit('intent:match', {
        requester: intent,
        responder: bestMatch.intent,
        similarity: bestMatch.similarity,
        distance: bestMatch.distance
      });
      
      this.stats.intentsFulfilled++;
      
      const matchTime = Date.now() - startTime;
      this.stats.avgMatchTime = 
        (this.stats.avgMatchTime * (this.stats.intentsFulfilled - 1) + matchTime)
        / this.stats.intentsFulfilled;
      
      console.log(`[IBR] Intent matched: ${intent.type} <-> ${bestMatch.intent.type}, similarity: ${bestMatch.similarity.toFixed(2)}`);
    }
    
    return matches;
  }
  
  /**
   * 獲取互補意圖類型
   */
  _getComplementaryTypes(type) {
    const complementaries = {
      'need:snowblower': ['offer:snowblower', 'offer:tool'],
      'need:ladder': ['offer:ladder', 'offer:tool'],
      'need:tool': ['offer:tool'],
      'need:food': ['offer:food', 'offer:groceries'],
      'offer:snowblower': ['need:snowblower'],
      'offer:tool': ['need:tool'],
      'offer:bike': ['need:bike'],
      'offer:food': ['need:food']
    };
    return complementaries[type] || [];
  }
  
  /**
   * 餘弦相似度
   */
  _cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
  
  /**
   * 計算距離 (km)
   */
  _calculateDistance(loc1, loc2) {
    const R = 6371; // 地球半徑 km
    const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
    const dLon = (loc2.lng - loc1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(loc1.lat * Math.PI / 180) * Math.cos(loc2.lat * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  /**
   * 處理傳入的意圖 (從網絡)
   */
  async handleIncomingIntent(remoteIntent) {
    // 存入本地表
    this.intentTable.set(remoteIntent.id, {
      ...remoteIntent,
      receivedAt: Date.now()
    });
    
    // 嘗試匹配本地意圖
    for (const [localId, localIntent] of this.intentTable) {
      if (localIntent.peerId === this.peerId) {
        const complementaryTypes = this._getComplementaryTypes(localIntent.type);
        if (complementaryTypes.includes(remoteIntent.type)) {
          const similarity = this._cosineSimilarity(localIntent.vector, remoteIntent.vector);
          if (similarity > 0.7) {
            this.emit('intent:match', {
              requester: localIntent,
              responder: remoteIntent,
              similarity
            });
          }
        }
      }
    }
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    return {
      ...this.stats,
      activeIntents: this.intentTable.size,
      intentTypes: this.weightGraph.size
    };
  }
  
  /**
   * 清理過期意圖
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, intent] of this.intentTable) {
      if (now - intent.timestamp > intent.ttl) {
        this.intentTable.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[IBR] Cleaned ${cleaned} expired intents`);
    }
  }
}

module.exports = { IntentBasedRouting };
