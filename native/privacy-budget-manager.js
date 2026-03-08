/**
 * Privacy Budget Manager - 全局隱私預算管理器
 * 
 * 追蹤並管理整個系統的差分隱私預算
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash } = require('crypto');

class PrivacyBudgetManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // 配置
    this.config = {
      // 用戶級別
      defaultEpsilon: options.defaultEpsilon || 1.0, // 默認隱私預算
      dailyBudget: options.dailyBudget || 10.0, // 每日預算上限
      totalBudget: options.totalBudget || 100.0, // 終身預算上限
      
      // 系統級別
      systemEpsilonLimit: options.systemEpsilonLimit || 1000.0, // 系統總預算
      warningThreshold: options.warningThreshold || 0.8, // 警告閾值
      
      // 冷卻
      cooldownPeriod: options.cooldownPeriod || 3600000, // 1小時
    };
    
    // 用戶預算
    this.userBudgets = new Map();
    
    // 系統總消耗
    this.systemSpent = 0;
    
    // 歷史記錄
    this.spendingHistory = [];
    
    // 每日重置定時器
    this.dailyResetTimer = null;
  }
  
  /**
   * 初始化用戶預算
   * @param {string} userId - 用戶 ID
   */
  initUserBudget(userId) {
    if (this.userBudgets.has(userId)) {
      return this.userBudgets.get(userId);
    }
    
    const budget = {
      userId,
      totalSpent: 0,
      dailySpent: 0,
      dailyResetAt: this._getNextResetTime(),
      lastActivity: Date.now(),
      status: 'active',
      transactions: []
    };
    
    this.userBudgets.set(userId, budget);
    
    console.log(`[PrivacyBudget] Initialized budget for user ${userId}`);
    
    return budget;
  }
  
  /**
   * 請求隱私預算
   * @param {string} userId - 用戶 ID
   * @param {number} epsilon - 請求的 epsilon
   * @param {string} purpose - 用途
   */
  async requestBudget(userId, epsilon, purpose) {
    let budget = this.userBudgets.get(userId);
    
    // 初始化如果不存在
    if (!budget) {
      budget = this.initUserBudget(userId);
    }
    
    // 檢查每日重置
    this._checkDailyReset(budget);
    
    // 檢查預算是否充足
    const available = this._getAvailableBudget(budget);
    
    if (available < epsilon) {
      // 嘗試從系統預算借用
      const systemAvailable = this._getSystemAvailable();
      
      if (systemAvailable >= epsilon) {
        // 系統批准借用
        const approved = await this._requestSystemApproval(userId, epsilon, purpose);
        
        if (!approved) {
          throw new Error(`Privacy budget exhausted. Available: ${available}, Requested: ${epsilon}`);
        }
      } else {
        throw new Error(`Privacy budget exhausted. Available: ${available}, Requested: ${epsilon}`);
      }
    }
    
    // 扣減預算
    budget.totalSpent += epsilon;
    budget.dailySpent += epsilon;
    this.systemSpent += epsilon;
    
    // 記錄交易
    const transaction = {
      id: createHash('sha256').update(Date.now() + userId).digest('hex').slice(0, 16),
      userId,
      epsilon,
      purpose,
      timestamp: Date.now(),
      remaining: available - epsilon
    };
    
    budget.transactions.push(transaction);
    this.spendingHistory.push(transaction);
    
    // 保持歷史大小
    if (budget.transactions.length > 1000) {
      budget.transactions.shift();
    }
    if (this.spendingHistory.length > 10000) {
      this.spendingHistory.shift();
    }
    
    // 檢查警告
    this._checkWarnings(budget);
    
    console.log(`[PrivacyBudget] Approved ${epsilon} for ${userId}, remaining: ${available - epsilon}`);
    
    return {
      approved: true,
      epsilon,
      remaining: available - epsilon,
      transactionId: transaction.id
    };
  }
  
  /**
   * 請求系統批准
   */
  async _requestSystemApproval(userId, epsilon, purpose) {
    // 檢查系統總預算
    if (this.systemSpent + epsilon > this.config.systemEpsilonLimit) {
      this.emit('system:budget:critical', {
        spent: this.systemSpent,
        limit: this.config.systemEpsilonLimit
      });
      return false;
    }
    
    // 記錄系統批准
    this.emit('system:budget:borrow', {
      userId,
      epsilon,
      purpose
    });
    
    return true;
  }
  
  /**
   * 獲取可用預算
   */
  _getAvailableBudget(budget) {
    const dailyRemaining = budget.dailyResetAt - Date.now() > 0
      ? this.config.dailyBudget - budget.dailySpent
      : this.config.dailyBudget;
    
    const totalRemaining = this.config.totalBudget - budget.totalSpent;
    
    return Math.min(dailyRemaining, totalRemaining);
  }
  
  /**
   * 獲取系統可用預算
   */
  _getSystemAvailable() {
    return this.config.systemEpsilonLimit - this.systemSpent;
  }
  
  /**
   * 檢查每日重置
   */
  _checkDailyReset(budget) {
    if (Date.now() >= budget.dailyResetAt) {
      budget.dailySpent = 0;
      budget.dailyResetAt = this._getNextResetTime();
      
      console.log(`[PrivacyBudget] Daily budget reset for ${budget.userId}`);
    }
  }
  
  /**
   * 獲取下次重置時間
   */
  _getNextResetTime() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime();
  }
  
  /**
   * 檢查警告
   */
  _checkWarnings(budget) {
    const dailyUsage = budget.dailySpent / this.config.dailyBudget;
    const totalUsage = budget.totalSpent / this.config.totalBudget;
    
    if (dailyUsage >= this.config.warningThreshold) {
      this.emit('user:daily:warning', {
        userId: budget.userId,
        usage: dailyUsage,
        remaining: this.config.dailyBudget - budget.dailySpent
      });
    }
    
    if (totalUsage >= this.config.warningThreshold) {
      this.emit('user:total:warning', {
        userId: budget.userId,
        usage: totalUsage,
        remaining: this.config.totalBudget - budget.totalSpent
      });
    }
  }
  
  /**
   * 獲取用戶預算狀態
   * @param {string} userId - 用戶 ID
   */
  getUserBudgetStatus(userId) {
    let budget = this.userBudgets.get(userId);
    
    if (!budget) {
      return { exists: false };
    }
    
    this._checkDailyReset(budget);
    
    const available = this._getAvailableBudget(budget);
    
    return {
      exists: true,
      userId: budget.userId,
      dailySpent: budget.dailySpent,
      dailyLimit: this.config.dailyBudget,
      dailyRemaining: Math.max(0, this.config.dailyBudget - budget.dailySpent),
      totalSpent: budget.totalSpent,
      totalLimit: this.config.totalBudget,
      totalRemaining: Math.max(0, this.config.totalBudget - budget.totalSpent),
      dailyUsage: budget.dailySpent / this.config.dailyBudget,
      totalUsage: budget.totalSpent / this.config.totalBudget,
      status: budget.status
    };
  }
  
  /**
   * 獲取系統預算狀態
   */
  getSystemBudgetStatus() {
    return {
      systemSpent: this.systemSpent,
      systemLimit: this.config.systemEpsilonLimit,
      systemRemaining: this._getSystemAvailable(),
      systemUsage: this.systemSpent / this.config.systemEpsilonLimit,
      userCount: this.userBudgets.size,
      activeUsers: Array.from(this.userBudgets.values())
        .filter(b => b.status === 'active').length
    };
  }
  
  /**
   * 獲取歷史記錄
   * @param {string} userId - 用戶 ID (可選)
   * @param {number} limit - 限制數量
   */
  getHistory(userId, limit = 100) {
    if (userId) {
      const budget = this.userBudgets.get(userId);
      if (!budget) return [];
      return budget.transactions.slice(-limit);
    }
    
    return this.spendingHistory.slice(-limit);
  }
  
  /**
   * 重置用戶預算
   * @param {string} userId - 用戶 ID
   */
  resetUserBudget(userId) {
    const budget = this.userBudgets.get(userId);
    if (budget) {
      budget.dailySpent = 0;
      budget.totalSpent = 0;
      budget.dailyResetAt = this._getNextResetTime();
      budget.transactions = [];
      
      console.log(`[PrivacyBudget] Reset budget for ${userId}`);
    }
  }
  
  /**
   * 暫停用戶
   * @param {string} userId - 用戶 ID
   */
  suspendUser(userId) {
    const budget = this.userBudgets.get(userId);
    if (budget) {
      budget.status = 'suspended';
      console.log(`[PrivacyBudget] Suspended user ${userId}`);
    }
  }
  
  /**
   * 恢復用戶
   * @param {string} userId - 用戶 ID
   */
  resumeUser(userId) {
    const budget = this.userBudgets.get(userId);
    if (budget) {
      budget.status = 'active';
      console.log(`[PrivacyBudget] Resumed user ${userId}`);
    }
  }
  
  /**
   * 導出審計報告
   */
  exportAuditReport() {
    const report = {
      generatedAt: Date.now(),
      system: this.getSystemBudgetStatus(),
      users: [],
      recentTransactions: this.spendingHistory.slice(-1000)
    };
    
    for (const [userId, budget] of this.userBudgets) {
      report.users.push({
        userId,
        ...this.getUserBudgetStatus(userId)
      });
    }
    
    return report;
  }
}

module.exports = { PrivacyBudgetManager };
