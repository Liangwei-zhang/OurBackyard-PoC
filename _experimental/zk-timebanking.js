/**
 * ZK Timebanking - 零知識時間銀行與算法物物交換
 * 
 * 帶有滯納衰減的零知識社區信用貨幣系統
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash, randomBytes } = require('crypto');

// 簡化的 ZK 證明系統
const ZK = {
  prove: (statement, witness) => {
    // 簡化: 生成假證明
    const hash = createHash('sha256')
      .update(JSON.stringify({ statement, witness }))
      .digest('hex');
    return { proof: hash, public: statement };
  },
  
  verify: (proof, statement) => {
    // 簡化: 總是返回 true
    return true;
  }
};

class ZKTimebanking extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // 配置
    this.config = {
      // 滯納參數 (貨幣衰減)
      demurrageRate: options.demurrageRate || 0.001, // 每小時衰減率
      initialCredits: options.initialCredits || 100, // 初始信用
      minBalance: options.minBalance || 0.01, // 最小餘額
      
      // 交換參數
      exchangeWindow: options.exchangeWindow || 3600000, // 1小時
      minTransaction: options.minTransaction || 1, // 最小交易額
      
      // H3 網格綁定
      h3Resolution: options.h3Resolution || 9,
      
      // ZK 參數
      privacyLevel: options.privacyLevel || 1 // 1-3, 越高越隱私
    };
    
    // 信用帳戶
    this.accounts = new Map();
    
    // 交易歷史 (加密)
    this.transactions = new Map();
    
    // 掛單市場
    this.market = new Map();
    
    // 待結算排隊
    this.pendingSettlements = [];
    
    // 全局信用總量
    this.totalSupply = 0;
  }
  
  /**
   * 創建帳戶
   * @param {string} peerId - 節點 ID
   * @param {string} h3 - H3 網格
   */
  createAccount(peerId, h3) {
    if (this.accounts.has(peerId)) {
      throw new Error('Account already exists');
    }
    
    const account = {
      peerId,
      h3,
      balance: this.config.initialCredits,
      createdAt: Date.now(),
      lastUpdate: Date.now(),
      
      // 歷史數據 (用於 ZK 證明)
      creditScore: 100, // 初始信用分
      totalEarned: 0,
      totalSpent: 0,
      completedExchanges: 0
    };
    
    this.accounts.set(peerId, account);
    this.totalSupply += this.config.initialCredits;
    
    console.log(`[Timebank] Created account for ${peerId}, initial credits: ${this.config.initialCredits}`);
    
    return account;
  }
  
  /**
   * 計算滯納衰減後的餘額
   * @param {number} balance - 原始餘額
   * @param {number} elapsedMs - 經過的毫秒數
   */
  calculateDemurrage(balance, elapsedMs) {
    const hours = elapsedMs / 3600000;
    // 指數衰減: B(t) = B0 * e^(-rate * t)
    const decayFactor = Math.exp(-this.config.demurrageRate * hours);
    return balance * decayFactor;
  }
  
  /**
   * 更新帳戶餘額 (應用滯納)
   */
  _updateAccountBalance(peerId) {
    const account = this.accounts.get(peerId);
    if (!account) return;
    
    const elapsedMs = Date.now() - account.lastUpdate;
    const newBalance = this.calculateDemurrage(account.balance, elapsedMs);
    
    // 記錄衰減
    const decayed = account.balance - newBalance;
    if (decayed > 0.01) {
      this.emit('demurrage', { peerId, decayed, newBalance });
    }
    
    account.balance = newBalance;
    account.lastUpdate = Date.now();
  }
  
  /**
   * 提供服務 (賺取信用)
   * @param {string} providerId - 服務提供者
   * @param {string} serviceType - 服務類型
   * @param {number} hours - 小時數
   * @param {string} description - 描述
   */
  async provideService(providerId, serviceType, hours, description) {
    const provider = this.accounts.get(providerId);
    if (!provider) {
      throw new Error('Provider account not found');
    }
    
    // 驗證服務
    const credits = hours; // 1 小時 = 1 信用
    
    // 生成 ZK 證明
    const proof = ZK.prove(
      { type: 'service', provider: providerId, hours, serviceType },
      { description, timestamp: Date.now() }
    );
    
    // 記錄交易
    const tx = {
      id: createHash('sha256').update(Date.now() + providerId).digest('hex').slice(0, 16),
      type: 'earn',
      provider: providerId,
      serviceType,
      hours,
      credits,
      proof,
      timestamp: Date.now(),
      status: 'pending'
    };
    
    this.transactions.set(tx.id, tx);
    this.pendingSettlements.push(tx);
    
    // 更新帳戶
    provider.balance += credits;
    provider.totalEarned += credits;
    provider.completedExchanges++;
    provider.lastUpdate = Date.now();
    
    // 提升信用分
    provider.creditScore = Math.min(200, provider.creditScore + hours * 2);
    
    console.log(`[Timebank] ${providerId} earned ${credits} credits for ${serviceType}`);
    
    return tx;
  }
  
  /**
   * 請求服務 (消費信用)
   * @param {string} requesterId - 請求者
   * @param {string} serviceType - 服務類型
   * @param {number} hours - 小時數
   */
  async requestService(requesterId, serviceType, hours) {
    const requester = this.accounts.get(requesterId);
    if (!requester) {
      throw new Error('Requester account not found');
    }
    
    // 應用滯納
    this._updateAccountBalance(requesterId);
    
    const cost = hours;
    
    if (requester.balance < cost) {
      throw new Error(`Insufficient balance: ${requester.balance} < ${cost}`);
    }
    
    // 生成 ZK 證明
    const proof = ZK.prove(
      { type: 'request', requester: requesterId, hours, serviceType },
      { timestamp: Date.now() }
    );
    
    // 記錄交易
    const tx = {
      id: createHash('sha256').update(Date.now() + requesterId).digest('hex').slice(0, 16),
      type: 'spend',
      requester: requesterId,
      serviceType,
      hours,
      credits: cost,
      proof,
      timestamp: Date.now(),
      status: 'pending'
    };
    
    this.transactions.set(tx.id, tx);
    this.pendingSettlements.push(tx);
    
    // 扣款
    requester.balance -= cost;
    requester.totalSpent += cost;
    requester.completedExchanges++;
    requester.lastUpdate = Date.now();
    
    // 降低信用分
    requester.creditScore = Math.max(0, requester.creditScore - hours);
    
    console.log(`[Timebank] ${requesterId} spent ${cost} credits for ${serviceType}`);
    
    return tx;
  }
  
  /**
   * 發布交換掛單
   * @param {string} peerId - 發布者
   * @param {Object} offer - 提供的服務
   * @param {Object} want - 想要的服務
   */
  async postListing(peerId, offer, want) {
    const account = this.accounts.get(peerId);
    if (!account) {
      throw new Error('Account not found');
    }
    
    const listing = {
      id: createHash('sha256').update(Date.now() + peerId).digest('hex').slice(0, 16),
      peerId,
      offer: {
        type: offer.type,
        hours: offer.hours,
        description: offer.description
      },
      want: {
        type: want.type,
        hours: want.hours,
        description: want.description
      },
      status: 'active',
      createdAt: Date.now(),
      matches: []
    };
    
    this.market.set(listing.id, listing);
    
    // 嘗試自動匹配
    await this._autoMatch(listing);
    
    return listing;
  }
  
  /**
   * 自動匹配
   */
  async _autoMatch(listing) {
    // 查找互補掛單
    for (const [otherId, other] of this.market) {
      if (otherId === listing.id || other.status !== 'active') continue;
      
      // 檢查是否互補
      if (this._isComplementary(listing, other)) {
        listing.matches.push(otherId);
        other.matches.push(listing.id);
        
        // 執行交換
        await this._executeBarter(listing, other);
      }
    }
  }
  
  /**
   * 檢查是否互補
   */
  _isComplementary(a, b) {
    return (
      a.want.type === b.offer.type &&
      b.want.type === a.offer.type
    );
  }
  
  /**
   * 執行以物易物
   */
  async _executeBarter(listingA, listingB) {
    const accountA = this.accounts.get(listingA.peerId);
    const accountB = this.accounts.get(listingB.peerId);
    
    // 驗證餘額
    this._updateAccountBalance(listingA.peerId);
    this._updateAccountBalance(listingB.peerId);
    
    const costA = listingA.offer.hours;
    const costB = listingB.offer.hours;
    
    if (accountA.balance < costA || accountB.balance < costB) {
      console.warn('[Timebank] Insufficient balance for barter');
      return;
    }
    
    // 執行雙向轉帳
    accountA.balance -= costA;
    accountA.balance += costB;
    accountA.totalSpent += costA;
    accountA.totalEarned += costB;
    accountA.completedExchanges += 2;
    
    accountB.balance -= costB;
    accountB.balance += costA;
    accountB.totalSpent += costB;
    accountB.totalEarned += costA;
    accountB.completedExchanges += 2;
    
    // 標記完成
    listingA.status = 'completed';
    listingB.status = 'completed';
    listingA.completedWith = listingB.id;
    listingB.completedWith = listingA.id;
    
    console.log(`[Timebank] Barter executed between ${listingA.peerId} and ${listingB.peerId}`);
    
    this.emit('barter:complete', {
      listingA: listingA.id,
      listingB: listingB.id
    });
  }
  
  /**
   * 獲取餘額 (隱私)
   * @param {string} peerId - 節點 ID
   * @param {boolean} applyDemurrage - 是否應用滯納
   */
  getBalance(peerId, applyDemurrage = true) {
    const account = this.accounts.get(peerId);
    if (!account) return 0;
    
    if (applyDemurrage) {
      this._updateAccountBalance(peerId);
    }
    
    return Math.max(0, account.balance);
  }
  
  /**
   * 獲取社區統計 (ZK 保護)
   */
  getCommunityStats() {
    // 只提供聚合統計，不暴露個人數據
    let totalBalance = 0;
    let totalEarned = 0;
    let totalSpent = 0;
    
    for (const account of this.accounts.values()) {
      totalBalance += this.getBalance(account.peerId);
      totalEarned += account.totalEarned;
      totalSpent += account.totalSpent;
    }
    
    // 應用全局滯納
    const avgDemurrage = this.config.demurrageRate * 24; // 每天
    
    return {
      totalAccounts: this.accounts.size,
      totalSupply: this.totalSupply,
      circulatingSupply: totalBalance,
      totalEarned,
      totalSpent,
      activeListings: Array.from(this.market.values()).filter(l => l.status === 'active').length,
      demurrageRate: this.config.demurrageRate,
      avgBalance: this.accounts.size > 0 ? totalBalance / this.accounts.size : 0
    };
  }
  
  /**
   * 轉移信用 (需要 ZK 證明)
   */
  async transfer(fromId, toId, amount) {
    if (amount < this.config.minTransaction) {
      throw new Error('Amount below minimum');
    }
    
    const from = this.accounts.get(fromId);
    const to = this.accounts.get(toId);
    
    if (!from || !to) {
      throw new Error('Account not found');
    }
    
    // 應用滯納
    this._updateAccountBalance(fromId);
    
    if (from.balance < amount) {
      throw new Error('Insufficient balance');
    }
    
    // 生成 ZK 證明
    const proof = ZK.prove(
      { type: 'transfer', from: fromId, to: toId, amount },
      { timestamp: Date.now() }
    );
    
    // 執行轉帳
    from.balance -= amount;
    to.balance += amount;
    
    // 記錄
    const tx = {
      id: createHash('sha256').update(Date.now() + fromId + toId).digest('hex').slice(0, 16),
      type: 'transfer',
      from: fromId,
      to: toId,
      amount,
      proof,
      timestamp: Date.now()
    };
    
    this.transactions.set(tx.id, tx);
    
    return tx;
  }
  
  /**
   * 銷毀過期信用 (系統操作)
   */
  burnExpired() {
    let burned = 0;
    
    for (const account of this.accounts.values()) {
      const oldBalance = account.balance;
      this._updateAccountBalance(account.peerId);
      burned += oldBalance - account.balance;
    }
    
    this.totalSupply -= burned;
    
    console.log(`[Timebank] Burned ${burned.toFixed(2)} expired credits`);
    
    return burned;
  }
  
  /**
   * 獲取帳戶歷史
   */
  getAccountHistory(peerId) {
    const history = [];
    
    for (const tx of this.transactions.values()) {
      if (tx.provider === peerId || tx.requester === peerId ||
          tx.from === peerId || tx.to === peerId) {
        history.push(tx);
      }
    }
    
    return history.sort((a, b) => b.timestamp - a.timestamp);
  }
  
  /**
   * 獲取市場掛單
   */
  getMarketListings(serviceType = null) {
    const listings = Array.from(this.market.values())
      .filter(l => l.status === 'active');
    
    if (serviceType) {
      return listings.filter(l => 
        l.offer.type === serviceType || l.want.type === serviceType
      );
    }
    
    return listings;
  }
}

module.exports = { ZKTimebanking };
