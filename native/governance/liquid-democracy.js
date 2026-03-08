/**
 * Liquid Democracy Governance - 液態民主治理
 * 
 * 實現權重動態委託與流轉，讓社區治理從「低頻投票」轉向「專業化協作」
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash } = require('crypto');

class LiquidDemocracy extends EventEmitter {
  constructor(libp2p, options = {}) {
    super();
    this.libp2p = libp2p;
    this.peerId = libp2p.peerId?.toString() || 'unknown';
    
    // 配置
    this.config = {
      minStake: options.minStake || 10, // 最小委託金額
      delegationRevokePeriod: options.delegationRevokePeriod || 86400000, // 24小時
      votingPowerDecay: options.votingPowerDecay || 0.9, // 投票權衰減
      maxDelegationDepth: options.maxDelegationDepth || 3 // 最大委託深度
    };
    
    // 委託關係圖
    this.delegations = new Map(); // delegator -> delegatee
    
    // 委託者列表 (按被委託者索引)
    this.delegatorsByDelegatee = new Map(); // delegatee -> [delegators]
    
    // 投票權重
    this.votingPower = new Map(); // peerId -> weight
    
    // 提案
    this.proposals = new Map();
    
    // 投票記錄
    this.votes = new Map(); // proposalId -> votes
    
    // 專業領域
    this.expertiseAreas = [
      'environmental',   // 環保
      'trade',          // 二手交易
      'infrastructure', // 基礎設施
      'events',         // 社區活動
      'security',       // 安全
      'finance'         // 財務
    ];
    
    // 初始化
    this._initVotingPower();
  }
  
  /**
   * 初始化投票權重
   */
  _initVotingPower() {
    // 每個節點基礎投票權重
    this.baseWeight = 1.0;
  }
  
  /**
   * 委託投票權
   * @param {string} delegateeId - 被委託者 ID
   * @param {string} expertise - 專業領域
   * @param {number} amount - 委託金額/權重
   */
  async delegate(delegateeId, expertise, amount = 1.0) {
    if (amount < this.config.minStake) {
      throw new Error(`Minimum delegation amount is ${this.config.minStake}`);
    }
    
    if (!this.expertiseAreas.includes(expertise)) {
      throw new Error(`Invalid expertise area: ${expertise}`);
    }
    
    const delegatorId = this.peerId;
    
    // 檢查循環委託
    if (await this._wouldCreateCycle(delegateeId)) {
      throw new Error('Delegation would create a cycle');
    }
    
    // 記錄委託
    this.delegations.set(delegatorId, {
      delegateeId,
      expertise,
      amount,
      delegatedAt: Date.now(),
      canRevokeAt: Date.now() + this.config.delegationRevokePeriod
    });
    
    // 更新反向索引
    if (!this.delegatorsByDelegatee.has(delegateeId)) {
      this.delegatorsByDelegatee.set(delegateeId, []);
    }
    this.delegatorsByDelegatee.get(delegateeId).push({
      delegatorId,
      expertise,
      amount
    });
    
    // 重新計算投票權重
    await this._recalculateVotingPower();
    
    console.log(`[Liquid Democracy] Delegated ${amount} to ${delegateeId} for ${expertise}`);
    
    return {
      delegatorId,
      delegateeId,
      expertise,
      amount,
      delegatedAt: Date.now()
    };
  }
  
  /**
   * 撤回委託
   */
  async revokeDelegation() {
    const delegatorId = this.peerId;
    const delegation = this.delegations.get(delegatorId);
    
    if (!delegation) {
      throw new Error('No active delegation');
    }
    
    // 檢查冷卻期
    if (Date.now() < delegation.canRevokeAt) {
      const remaining = delegation.canRevokeAt - Date.now();
      throw new Error(`Can revoke in ${Math.ceil(remaining / 3600000)} hours`);
    }
    
    const delegateeId = delegation.delegateeId;
    
    // 移除委託
    this.delegations.delete(delegatorId);
    
    // 更新反向索引
    const delegators = this.delegatorsByDelegatee.get(delegateeId);
    if (delegators) {
      const index = delegators.findIndex(d => d.delegatorId === delegatorId);
      if (index !== -1) delegators.splice(index, 1);
    }
    
    // 重新計算
    await this._recalculateVotingPower();
    
    console.log(`[Liquid Democracy] Revoked delegation to ${delegateeId}`);
    
    return { revoked: true };
  }
  
  /**
   * 檢查是否會形成循環
   */
  async _wouldCreateCycle(targetId) {
    let current = targetId;
    const visited = new Set();
    
    for (let i = 0; i < this.config.maxDelegationDepth; i++) {
      if (visited.has(current)) return true;
      visited.add(current);
      
      const delegation = this.delegations.get(current);
      if (!delegation) break;
      
      current = delegation.delegateeId;
    }
    
    return false;
  }
  
  /**
   * 重新計算投票權重
   */
  async _recalculateVotingPower() {
    // 初始化所有節點權重
    const allPeers = new Set([
      ...this.delegations.keys(),
      ...Array.from(this.delegations.values()).map(d => d.delegateeId)
    ]);
    
    for (const peerId of allPeers) {
      const weight = await this._calculateVotingPower(peerId);
      this.votingPower.set(peerId, weight);
    }
  }
  
  /**
   * 計算單個節點的投票權重
   */
  async _calculateVotingPower(peerId) {
    // 基礎權重
    let totalWeight = this.baseWeight;
    
    // 直接委託給該節點的權重
    const directDelegators = this.delegatorsByDelegatee.get(peerId) || [];
    
    for (const delegator of directDelegators) {
      totalWeight += delegator.amount;
    }
    
    // 遞歸委託 (衰減)
    const indirectWeight = await this._calculateIndirectWeight(peerId, 1);
    totalWeight += indirectWeight;
    
    return totalWeight;
  }
  
  /**
   * 計算間接委託權重 (遞歸)
   */
  async _calculateIndirectWeight(peerId, depth) {
    if (depth > this.config.maxDelegationDepth) return 0;
    
    const directDelegators = this.delegatorsByDelegatee.get(peerId) || [];
    let indirectWeight = 0;
    
    for (const delegator of directDelegators) {
      // 遞歸計算該委託者的委託對象
      const subDelegation = this.delegations.get(delegator.delegatorId);
      if (subDelegation && subDelegation.delegateeId !== peerId) {
        const subWeight = await this._calculateVotingPower(subDelegation.delegateeId);
        indirectWeight += subWeight * delegator.amount * Math.pow(this.config.votingPowerDecay, depth);
      }
    }
    
    return indirectWeight;
  }
  
  /**
   * 創建提案
   * @param {string} title - 標題
   * @param {string} description - 描述
   * @param {string} expertise - 需要的專業領域
   * @param {number} votingPeriod - 投票期 (ms)
   */
  async createProposal(title, description, expertise, votingPeriod = 604800000) {
    const proposalId = createHash('sha256')
      .update(title + Date.now())
      .digest('hex').slice(0, 16);
    
    const proposal = {
      id: proposalId,
      title,
      description,
      expertise,
      author: this.peerId,
      createdAt: Date.now(),
      votingEndsAt: Date.now() + votingPeriod,
      status: 'active',
      votes: {
        for: 0,
        against: 0,
        abstain: 0
      },
      voters: new Set()
    };
    
    this.proposals.set(proposalId, proposal);
    this.votes.set(proposalId, []);
    
    console.log(`[Liquid Democracy] Created proposal: ${title} (${proposalId})`);
    
    return proposal;
  }
  
  /**
   * 投票
   * @param {string} proposalId - 提案 ID
   * @param {string} vote - 投票: 'for', 'against', 'abstain'
   * @param {string} reason - 理由
   */
  async vote(proposalId, vote, reason = '') {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    if (proposal.status !== 'active') {
      throw new Error('Proposal is not active');
    }
    
    if (Date.now() > proposal.votingEndsAt) {
      throw new Error('Voting period has ended');
    }
    
    // 獲取投票權重
    const weight = this.votingPower.get(this.peerId) || this.baseWeight;
    
    // 記錄投票
    const voteRecord = {
      voter: this.peerId,
      vote,
      weight,
      reason,
      timestamp: Date.now()
    };
    
    this.votes.get(proposalId).push(voteRecord);
    proposal.voters.add(this.peerId);
    
    // 更新提案計數
    proposal.votes[vote] += weight;
    
    console.log(`[Liquid Democracy] Voted ${vote} with weight ${weight} on proposal ${proposalId}`);
    
    return voteRecord;
  }
  
  /**
   * 委託投票 (讓代理人代投)
   * @param {string} proposalId - 提案 ID
   * @param {string} agentId - 代理人 ID
   */
  async delegateVote(proposalId, agentId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    // 檢查是否有委託關係
    const delegation = this.delegations.get(this.peerId);
    if (!delegation || delegation.delegateeId !== agentId) {
      throw new Error('No delegation to this agent');
    }
    
    // 檢查代理人是否有該專業領域的專業度
    const agentExpertise = await this._getAgentExpertise(agentId, proposal.expertise);
    
    if (agentExpertise < 0.5) {
      throw new Error('Agent lacks expertise in required area');
    }
    
    // 觸發代理人投票事件
    this.emit('delegate:vote', {
      proposalId,
      agentId,
      delegator: this.peerId,
      expertise: proposal.expertise
    });
    
    return { delegated: true, agentId };
  }
  
  /**
   * 獲取代理人的專業度
   */
  async _getAgentExpertize(agentId, expertise) {
    // 統計該領域的委託數量
    const delegators = this.delegatorsByDelegatee.get(agentId) || [];
    const expertiseDelegators = delegators.filter(d => d.expertise === expertise);
    
    if (expertiseDelegators.length === 0) return 0;
    
    // 專業度 = 委託數量 / 總委託數量
    return expertiseDelegators.length / delegators.length;
  }
  
  /**
   * 結算提案
   */
  async settleProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    if (proposal.status !== 'active') {
      throw new Error('Proposal already settled');
    }
    
    const totalVotes = proposal.votes.for + proposal.votes.against + proposal.votes.abstain;
    
    // 計算權重
    const totalWeight = Array.from(this.votingPower.values())
      .reduce((sum, w) => sum + w, 0);
    
    const forWeight = proposal.votes.for;
    const againstWeight = proposal.votes.against;
    
    // 簡單多數決
    const passed = forWeight > againstWeight;
    
    proposal.status = passed ? 'passed' : 'rejected';
    proposal.settledAt = Date.now();
    proposal.totalVotes = totalVotes;
    proposal.turnout = totalWeight > 0 ? totalVotes / totalWeight : 0;
    
    console.log(`[Liquid Democracy] Proposal ${proposalId} ${proposal.status}`);
    
    return {
      id: proposalId,
      status: proposal.status,
      votes: proposal.votes,
      turnout: proposal.turnout
    };
  }
  
  /**
   * 轉移提案 (專業化處理)
   */
  async transferProposal(proposalId, expertPeerId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    // 檢查目標節點是否為專家
    const expertise = await this._getAgentExpertise(expertPeerId, proposal.expertise);
    
    if (expertise < 0.3) {
      throw new Error('Target peer is not a recognized expert');
    }
    
    // 記錄轉移
    proposal.transferredTo = expertPeerId;
    proposal.transferredAt = Date.now();
    
    this.emit('proposal:transfer', {
      proposalId,
      from: this.peerId,
      to: expertPeerId,
      expertise: proposal.expertise
    });
    
    return { transferred: true, expertPeerId };
  }
  
  /**
   * 獲取委託圖
   */
  getDelegationGraph() {
    const graph = {
      nodes: [],
      edges: []
    };
    
    // 節點
    for (const [peerId, weight] of this.votingPower) {
      graph.nodes.push({
        id: peerId,
        votingPower: weight,
        isExpert: this.delegatorsByDelegatee.has(peerId)
      });
    }
    
    // 邊
    for (const [delegator, delegation] of this.delegations) {
      graph.edges.push({
        from: delegator,
        to: delegation.delegateeId,
        expertise: delegation.expertise,
        weight: delegation.amount
      });
    }
    
    return graph;
  }
  
  /**
   * 獲取專業領域分佈
   */
  getExpertiseDistribution() {
    const distribution = {};
    
    for (const expertise of this.expertiseAreas) {
      distribution[expertise] = {
        delegates: 0,
        totalWeight: 0,
        experts: []
      };
    }
    
    for (const [delegatee, delegators] of this.delegatorsByDelegatee) {
      for (const d of delegators) {
        if (distribution[d.expertise]) {
          distribution[d.expertise].delegates++;
          distribution[d.expertise].totalWeight += d.amount;
          
          if (d.amount > 5) {
            distribution[d.expertise].experts.push({
              peerId: delegatee,
              weight: d.amount
            });
          }
        }
      }
    }
    
    return distribution;
  }
  
  /**
   * 獲取狀態
   */
  getStatus() {
    return {
      totalDelegations: this.delegations.size,
      activeProposals: Array.from(this.proposals.values()).filter(p => p.status === 'active').length,
      settledProposals: Array.from(this.proposals.values()).filter(p => p.status !== 'active').length,
      votingPowerRange: {
        min: Math.min(...Array.from(this.votingPower.values())),
        max: Math.max(...Array.from(this.votingPower.values()))
      },
      expertiseAreas: this.expertiseAreas
    };
  }
}

module.exports = { LiquidDemocracy };
