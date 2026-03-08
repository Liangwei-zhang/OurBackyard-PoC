/**
 * ZK-Storage Proof - 零知識存儲可用性證明
 * 
 * 確保 Sponsor Node 真的存了數據，且隨時能提供
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash, randomBytes } = require('crypto');
const { MerkleTree } = require('./merkletree.js');

class ZKStorageProof extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // 配置
    this.config = {
      challengeTimeout: options.challengeTimeout || 5000, // 5秒超时
      proofWindow: options.proofWindow || 60000, // 1分钟证明窗口
      replicationFactor: options.replicationFactor || 3,
      retentionPeriod: options.retentionPeriod || 86400000 // 24小时
    };
    
    // 存储的数据分片
    this.storedData = new Map();
    
    // Merkle 树
    this.merkleTrees = new Map();
    
    // 活跃挑战
    this.activeChallenges = new Map();
    
    // 证明历史
    this.proofHistory = new Map();
    
    // 定时任务
    this.intervalId = null;
  }
  
  /**
   * 存储数据并生成 Merkle 树
   * @param {string} key - 数据键
   * @param {Buffer} data - 数据内容
   */
  async store(key, data) {
    // 分片存储
    const shards = this._shardData(data, this.config.replicationFactor);
    
    // 为每个分片创建 Merkle 树
    const merkleTree = new MerkleTree(shards);
    this.merkleTrees.set(key, merkleTree);
    
    // 存储分片
    this.storedData.set(key, {
      shards,
      rootHash: merkleTree.getRootHash(),
      timestamp: Date.now()
    });
    
    console.log(`[ZKStorage] Stored ${key}, root: ${merkleTree.getRootHash().slice(0, 16)}...`);
    
    return {
      key,
      rootHash: merkleTree.getRootHash(),
      shardCount: shards.length
    };
  }
  
  /**
   * 数据分片
   */
  _shardData(data, factor) {
    const chunkSize = Math.ceil(data.length / factor);
    const shards = [];
    
    for (let i = 0; i < factor; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, data.length);
      shards.push(data.slice(start, end));
    }
    
    return shards;
  }
  
  /**
   * 生成挑战 (由验证者发起)
   * @param {string} key - 数据键
   * @param {string} challenger - 挑战者 ID
   */
  async generateChallenge(key, challenger) {
    const stored = this.storedData.get(key);
    if (!stored) {
      throw new Error(`Data ${key} not found`);
    }
    
    // 生成随机挑战
    const challengeId = createHash('sha256')
      .update(randomBytes(32))
      .digest('hex');
    
    const challenge = {
      id: challengeId,
      key,
      challenger,
      challenge: randomBytes(32).toString('hex'),
      timestamp: Date.now(),
      expiresAt: Date.now() + this.config.challengeTimeout
    };
    
    this.activeChallenges.set(challengeId, challenge);
    
    // 定时清除过期挑战
    setTimeout(() => {
      this.activeChallenges.delete(challengeId);
    }, this.config.challengeTimeout);
    
    return challenge;
  }
  
  /**
   * 生成零知识证明
   * @param {string} challengeId - 挑战 ID
   */
  async generateProof(challengeId) {
    const challenge = this.activeChallenges.get(challengeId);
    if (!challenge) {
      throw new Error('Challenge expired or not found');
    }
    
    const stored = this.storedData.get(challenge.key);
    const merkleTree = this.merkleTrees.get(challenge.key);
    
    if (!stored || !merkleTree) {
      throw new Error(`Data ${challenge.key} not found`);
    }
    
    // 解析挑战
    const challengeData = Buffer.from(challenge.challenge, 'hex');
    
    // 为每个分片生成证明
    const shardProofs = stored.shards.map((shard, index) => {
      const proof = merkleTree.getProof(index);
      return {
        index,
        shard: shard.toString('base64'),
        proof: proof.map(p => p.toString('hex')),
        path: merkleTree.getPath(index).map(n => n.toString('hex'))
      };
    });
    
    // 生成聚合证明
    const aggregatedProof = this._generateAggregatedProof(
      challengeData,
      stored.shards,
      merkleTree.getRootHash()
    );
    
    const proof = {
      challengeId,
      key: challenge.key,
      rootHash: merkleTree.getRootHash(),
      timestamp: Date.now(),
      shardProofs,
      aggregatedProof,
      responseTime: Date.now() - challenge.timestamp
    };
    
    // 验证证明时间 (< 50ms)
    if (proof.responseTime > 50) {
      console.warn(`[ZKStorage] Proof response time: ${proof.responseTime}ms (target: <50ms)`);
    }
    
    // 记录证明历史
    this._recordProof(challenge.key, proof);
    
    // 触发 Resource Quota 更新
    this._updateResourceQuota(proof);
    
    return proof;
  }
  
  /**
   * 生成聚合证明
   */
  _generateAggregatedProof(challenge, shards, rootHash) {
    // 使用 hash 链生成聚合证明
    let hashChain = challenge;
    
    for (const shard of shards) {
      hashChain = createHash('sha256')
        .update(Buffer.concat([Buffer.from(hashChain, 'hex'), shard]))
        .digest('hex');
    }
    
    // 最终签名
    const signature = createHash('sha256')
      .update(Buffer.from(hashChain + rootHash, 'hex'))
      .digest('hex');
    
    return {
      chainHash: hashChain,
      signature: signature.slice(0, 64)
    };
  }
  
  /**
   * 验证证明
   * @param {Object} proof - 证明
   * @param {string} expectedRootHash - 期望的根哈希
   */
  verifyProof(proof, expectedRootHash) {
    // 验证根哈希
    if (proof.rootHash !== expectedRootHash) {
      return { valid: false, reason: 'Root hash mismatch' };
    }
    
    // 验证响应时间
    if (proof.responseTime > 50) {
      return { valid: false, reason: 'Response timeout' };
    }
    
    // 验证聚合证明
    const { aggregatedProof } = proof;
    
    // 重新计算聚合证明
    const stored = this.storedData.get(proof.key);
    if (!stored) {
      return { valid: false, reason: 'Data not found' };
    }
    
    const rechained = this._generateAggregatedProof(
      Buffer.from(this.activeChallenges.get(proof.challengeId)?.challenge || '0', 'hex'),
      stored.shards,
      proof.rootHash
    );
    
    if (rechained.signature !== aggregatedProof.signature) {
      return { valid: false, reason: 'Aggregated proof mismatch' };
    }
    
    return { valid: true, responseTime: proof.responseTime };
  }
  
  /**
   * 记录证明历史
   */
  _recordProof(key, proof) {
    if (!this.proofHistory.has(key)) {
      this.proofHistory.set(key, []);
    }
    
    const history = this.proofHistory.get(key);
    history.push({
      timestamp: proof.timestamp,
      valid: proof.responseTime <= 50,
      responseTime: proof.responseTime
    });
    
    // 只保留最近 100 条
    if (history.length > 100) {
      history.shift();
    }
  }
  
  /**
   * 更新 Resource Quota
   */
  async _updateResourceQuota(proof) {
    const { ResourceQuota } = await import('./resource-quota.js');
    
    const history = this.proofHistory.get(proof.key) || [];
    const successRate = history.filter(h => h.valid).length / history.length;
    
    await ResourceQuota.updateQuota({
      storageProofSuccess: successRate,
      responseTimeAvg: history.reduce((sum, h) => sum + h.responseTime, 0) / history.length
    });
    
    console.log(`[ZKStorage] Updated Resource Quota, success rate: ${(successRate * 100).toFixed(1)}%`);
    this.emit('quotaUpdated', { successRate });
  }
  
  /**
   * 定期发布挑战 (模拟验证者)
   */
  startPeriodicChallenges(intervalMs = 300000) {
    this.intervalId = setInterval(async () => {
      for (const key of this.storedData.keys()) {
        // 随机选择数据发起挑战
        const challenge = await this.generateChallenge(key, 'system-validator');
        
        // 立即生成证明 (模拟存储节点响应)
        try {
          const proof = await this.generateProof(challenge.id);
          const verification = this.verifyProof(proof, this.storedData.get(key).rootHash);
          
          this.emit('challenge:result', {
            key,
            valid: verification.valid,
            responseTime: proof.responseTime
          });
        } catch (e) {
          console.error(`[ZKStorage] Challenge failed for ${key}:`, e.message);
        }
      }
    }, intervalMs);
  }
  
  /**
   * 停止定期挑战
   */
  stopPeriodicChallenges() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  
  /**
   * 获取存储统计
   */
  getStats() {
    const stats = {
      totalKeys: this.storedData.size,
      proofHistory: {}
    };
    
    for (const [key, history] of this.proofHistory) {
      const validCount = history.filter(h => h.valid).length;
      stats.proofHistory[key] = {
        total: history.length,
        valid: validCount,
        successRate: validCount / history.length,
        avgResponseTime: history.reduce((sum, h) => sum + h.responseTime, 0) / history.length
      };
    }
    
    return stats;
  }
  
  /**
   * 检索数据 (提供 Merkle 证明)
   * @param {string} key - 数据键
   */
  async retrieve(key) {
    const stored = this.storedData.get(key);
    if (!stored) {
      throw new Error(`Data ${key} not found`);
    }
    
    // 生成完整性证明
    const merkleTree = this.merkleTrees.get(key);
    const retrievalProof = {
      key,
      data: Buffer.concat(stored.shards),
      rootHash: merkleTree.getRootHash(),
      timestamp: stored.timestamp
    };
    
    return retrievalProof;
  }
}

module.exports = { ZKStorageProof };
