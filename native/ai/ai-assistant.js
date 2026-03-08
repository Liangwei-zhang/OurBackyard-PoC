/**
 * AI Assistant - AI 輔助匹配
 * 
 * 簡化版的 AI 代理，輔助而非完全自主
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash } = require('crypto');

class AIAssistant extends EventEmitter {
  constructor(libp2p, options = {}) {
    super();
    this.libp2p = libp2p;
    this.peerId = libp2p.peerId?.toString() || 'unknown';
    
    // 配置
    this.config = {
      matchThreshold: options.matchThreshold || 0.7,
      suggestionLimit: options.suggestionLimit || 5,
      learnFromHistory: options.learnFromHistory !== false,
      
      // 意圖類型
      intentCategories: [
        'need',    // 需要東西
        'offer',   // 提供東西
        'help',    // 需要幫助
        'trade'    // 交換
      ]
    };
    
    // 用戶意圖緩存
    this.userIntents = new Map();
    
    // 匹配歷史
    this.matchHistory = [];
    
    // 偏好學習
    this.preferenceModel = this._initPreferenceModel();
    
    // 市場數據
    this.marketData = {
      recentListings: [],
      priceDistribution: {},
      popularCategories: {}
    };
  }
  
  /**
   * 初始化偏好模型
   */
  _initPreferenceModel() {
    return {
      // 偏好向量
      categories: {},
      priceRange: [0, 1000],
      location: null,
      timeAvailability: [],
      
      // 學習參數
      learningRate: 0.01,
      memorySize: 100
    };
  }
  
  /**
   * 解析用戶意圖
   * @param {string} userId - 用戶 ID
   * @param {string} text - 自然語言輸入
   */
  parseIntent(userId, text) {
    const text_lower = text.toLowerCase();
    
    // 意圖分類
    let intentType = 'need';
    if (text_lower.includes('want') || text_lower.includes('need') || text_lower.includes('需要')) {
      intentType = 'need';
    } else if (text_lower.includes('have') || text_lower.includes('offer') || text_lower.includes('有')) {
      intentType = 'offer';
    } else if (text_lower.includes('help') || text_lower.includes('幫') || text_lower.includes('求助')) {
      intentType = 'help';
    } else if (text_lower.includes('trade') || text_lower.includes('交換') || text_lower.includes('換')) {
      intentType = 'trade';
    }
    
    // 提取關鍵詞
    const keywords = this._extractKeywords(text);
    
    // 提取價格範圍
    const priceRange = this._extractPriceRange(text);
    
    // 緊急性
    const urgency = this._extractUrgency(text);
    
    const intent = {
      id: createHash('sha256').update(userId + Date.now()).digest('hex').slice(0, 16),
      userId,
      type: intentType,
      text,
      keywords,
      priceRange,
      urgency,
      timestamp: Date.now(),
      status: 'active'
    };
    
    // 存儲
    if (!this.userIntents.has(userId)) {
      this.userIntents.set(userId, []);
    }
    this.userIntents.get(userId).push(intent);
    
    // 更新偏好模型
    if (this.config.learnFromHistory) {
      this._updatePreferenceModel(userId, intent);
    }
    
    console.log(`[AI] Parsed intent for ${userId}: ${intentType}`);
    
    return intent;
  }
  
  /**
   * 提取關鍵詞
   */
  _extractKeywords(text) {
    const commonWords = new Set([
      'i', 'me', 'my', 'want', 'need', 'have', 'would', 'could',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of',
      '我', '想', '要', '有', '沒有', '可以', '幫', '請'
    ]);
    
    const words = text.toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !commonWords.has(w));
    
    return [...new Set(words)].slice(0, 10);
  }
  
  /**
   * 提取價格範圍
   */
  _extractPriceRange(text) {
    const priceMatch = text.match(/\$?(\d+)(?:\s*-\s*\$?(\d+))?/);
    
    if (priceMatch) {
      const min = parseInt(priceMatch[1]);
      const max = priceMatch[2] ? parseInt(priceMatch[2]) : min * 1.5;
      return [Math.min(min, max), Math.max(min, max)];
    }
    
    return [0, 1000];
  }
  
  /**
   * 提取緊急性
   */
  _extractUrgency(text) {
    const urgentWords = ['urgent', 'asap', 'now', 'immediately', '緊急', '馬上', '立刻', '現在'];
    const soonWords = ['soon', 'this weekend', 'this week', '這週', '這週末', '盡快'];
    
    const text_lower = text.toLowerCase();
    
    if (urgentWords.some(w => text_lower.includes(w))) return 'critical';
    if (soonWords.some(w => text_lower.includes(w))) return 'high';
    return 'normal';
  }
  
  /**
   * 更新偏好模型
   */
  _updatePreferenceModel(userId, intent) {
    const model = this.preferenceModel;
    
    // 更新類別偏好
    for (const keyword of intent.keywords) {
      if (!model.categories[keyword]) {
        model.categories[keyword] = 0;
      }
      model.categories[keyword] += 1;
    }
    
    // 更新價格範圍
    model.priceRange[0] = Math.min(model.priceRange[0], intent.priceRange[0]);
    model.priceRange[1] = Math.max(model.priceRange[1], intent.priceRange[1]);
  }
  
  /**
   * 建議匹配
   * @param {string} userId - 用戶 ID
   * @param {Object} options - 選項
   */
  suggestMatches(userId, options = {}) {
    const limit = options.limit || this.config.suggestionLimit;
    const threshold = options.threshold || this.config.matchThreshold;
    
    const userIntent = this.userIntents.get(userId)?.[this.userIntents.get(userId).length - 1];
    
    if (!userIntent) {
      throw new Error('No active intent found');
    }
    
    const allIntents = [];
    
    // 收集其他用戶的意圖
    for (const [otherUserId, intents] of this.userIntents) {
      if (otherUserId === userId) continue;
      
      const otherIntent = intents[intents.length - 1];
      if (otherIntent.status !== 'active') continue;
      
      allIntents.push(otherIntent);
    }
    
    // 計算匹配度
    const scored = allIntents.map(intent => {
      const score = this._calculateMatchScore(userIntent, intent);
      return { intent, score };
    });
    
    // 排序
    scored.sort((a, b) => b.score - a.score);
    
    // 過濾
    const matches = scored
      .filter(m => m.score >= threshold)
      .slice(0, limit)
      .map(m => ({
        ...m.intent,
        matchScore: m.score,
        reason: this._generateMatchReason(userIntent, m.intent, m.score)
      }));
    
    console.log(`[AI] Found ${matches.length} matches for ${userId}`);
    
    return matches;
  }
  
  /**
   * 計算匹配度
   */
  _calculateMatchScore(intentA, intentB) {
    // 互補類型匹配
    const complementary = {
      'need': 'offer',
      'offer': 'need',
      'help': 'help',
      'trade': 'trade'
    };
    
    if (complementary[intentA.type] !== intentB.type) {
      return 0;
    }
    
    let score = 0;
    
    // 關鍵詞重疊
    const keywordsA = new Set(intentA.keywords);
    const keywordsB = new Set(intentB.keywords);
    const intersection = [...keywordsA].filter(k => keywordsB.has(k));
    const union = new Set([...keywordsA, ...keywordsB]);
    
    const keywordScore = intersection.length / union.size;
    score += keywordScore * 0.5;
    
    // 價格範圍重疊
    const priceOverlap = this._calculateRangeOverlap(
      intentA.priceRange,
      intentB.priceRange
    );
    score += priceOverlap * 0.3;
    
    // 緊急性匹配
    if (intentA.urgency === intentB.urgency) {
      score += 0.1;
    }
    
    // 時間衰減
    const age = Date.now() - intentB.timestamp;
    const ageFactor = Math.max(0, 1 - age / 86400000); // 24小時衰減
    score += ageFactor * 0.1;
    
    return Math.min(1, score);
  }
  
  /**
   * 計算範圍重疊
   */
  _calculateRangeOverlap(rangeA, rangeB) {
    const start = Math.max(rangeA[0], rangeB[0]);
    const end = Math.min(rangeA[1], rangeB[1]);
    
    if (start > end) return 0;
    
    const overlap = end - start;
    const union = Math.max(rangeA[1], rangeB[1]) - Math.min(rangeA[0], rangeB[0]);
    
    return overlap / union;
  }
  
  /**
   * 生成匹配原因
   */
  _generateMatchReason(intentA, intentB, score) {
    const reasons = [];
    
    // 關鍵詞匹配
    const common = intentA.keywords.filter(k => intentB.keywords.includes(k));
    if (common.length > 0) {
      reasons.push(`關鍵詞匹配: ${common.slice(0, 3).join(', ')}`);
    }
    
    // 價格匹配
    const overlap = this._calculateRangeOverlap(intentA.priceRange, intentB.priceRange);
    if (overlap > 0.5) {
      reasons.push('價格範圍相近');
    }
    
    // 緊急程度
    if (intentA.urgency === intentB.urgency) {
      reasons.push('緊急程度匹配');
    }
    
    return reasons.join('; ') || '需求互補';
  }
  
  /**
   * 語音命令處理
   * @param {string} userId - 用戶 ID
   * @param {string} command - 語音命令
   */
  async handleVoiceCommand(userId, command) {
    console.log(`[AI] Processing voice command: "${command}"`);
    
    // 解析意圖
    const intent = this.parseIntent(userId, command);
    
    // 獲取建議
    const suggestions = this.suggestMatches(userId);
    
    // 格式化響應
    const response = this._formatResponse(intent, suggestions);
    
    return response;
  }
  
  /**
   * 格式化響應
   */
  _formatResponse(intent, suggestions) {
    const typeMessages = {
      'need': '我幫你找到了',
      'offer': '可以提供給你的人有',
      'help': '可以幫你的人有',
      'trade': '可以和你交換的有'
    };
    
    let message = typeMessages[intent.type] || '找到以下';
    
    if (suggestions.length === 0) {
      message = '暫時沒有找到合適的匹配，建議你可以：\n1. 擴大搜索範圍\n2. 調整價格範圍\n3. 稍後再試';
    } else {
      message += ` ${suggestions.length} 個選項：\n\n`;
      
      suggestions.forEach((s, i) => {
        message += `${i + 1}. ${s.userId.slice(0, 8)}... - ${s.matchScore.toFixed(1)}% 匹配\n`;
        message += `   原因: ${s.reason}\n`;
      });
      
      message += '\n點擊查看詳情或直接聯繫';
    }
    
    return {
      message,
      intent: intent.id,
      suggestions: suggestions.map(s => ({
        userId: s.userId,
        score: s.matchScore,
        reason: s.reason
      })),
      action: suggestions.length > 0 ? 'show_matches' : 'wait'
    };
  }
  
  /**
   * 處理確認
   * @param {string} userId - 用戶 ID
   * @param {string} matchId - 匹配 ID
   */
  async handleConfirmation(userId, matchId) {
    const intents = this.userIntents.get(userId);
    const userIntent = intents?.[intents.length - 1];
    
    if (!userIntent) {
      throw new Error('No intent found');
    }
    
    // 記錄匹配歷史
    this.matchHistory.push({
      userId,
      matchId,
      intentId: userIntent.id,
      timestamp: Date.now(),
      status: 'confirmed'
    });
    
    // 更新市場數據
    this._updateMarketData(userIntent);
    
    console.log(`[AI] Match confirmed: ${userId} <-> ${matchId}`);
    
    return {
      success: true,
      nextStep: 'initiate_contact'
    };
  }
  
  /**
   * 更新市場數據
   */
  _updateMarketData(intent) {
    this.marketData.recentListings.push({
      type: intent.type,
      keywords: intent.keywords,
      priceRange: intent.priceRange,
      timestamp: Date.now()
    });
    
    // 保持最近 100 條
    if (this.marketData.recentListings.length > 100) {
      this.marketData.recentListings.shift();
    }
    
    // 更新熱門類別
    for (const kw of intent.keywords) {
      this.marketData.popularCategories[kw] = 
        (this.marketData.popularCategories[kw] || 0) + 1;
    }
  }
  
  /**
   * 獲取市場趨勢
   */
  getMarketTrends() {
    const trends = Object.entries(this.marketData.popularCategories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([keyword, count]) => ({ keyword, count }));
    
    return {
      trends,
      totalListings: this.marketData.recentListings.length,
      avgPrice: this.marketData.recentListings.length > 0
        ? this.marketData.recentListings.reduce((sum, l) => sum + (l.priceRange[0] + l.priceRange[1]) / 2, 0) / 
          this.marketData.recentListings.length
        : 0
    };
  }
  
  /**
   * 獲取用戶偏好
   */
  getUserPreferences(userId) {
    return {
      categories: this.preferenceModel.categories,
      priceRange: this.preferenceModel.priceRange,
      matchCount: this.matchHistory.filter(m => m.userId === userId).length
    };
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    return {
      activeIntents: Array.from(this.userIntents.values())
        .filter(intents => intents[intents.length - 1]?.status === 'active').length,
      totalMatches: this.matchHistory.length,
      confirmedMatches: this.matchHistory.filter(m => m.status === 'confirmed').length,
      marketTrends: this.getMarketTrends()
    };
  }
}

module.exports = { AIAssistant };
