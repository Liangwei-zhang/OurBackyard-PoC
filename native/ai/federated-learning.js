/**
 * Federated Edge Learning - 聯邦邊緣學習
 * 
 * 實現 P2P 聯邦學習，匯集社區集體智能但不上傳隱私
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { GossipSub } = require('libp2p-gossipsub');
const { createHash } = require('crypto');

class FederatedEdgeLearning extends EventEmitter {
  constructor(libp2p, options = {}) {
    super();
    this.libp2p = libp2p;
    this.peerId = libp2p.peerId.toString();
    
    // 模型配置
    this.modelConfig = {
      embeddingDim: options.embeddingDim || 128,
      local_epochs: options.localEpochs || 5,
      batchSize: options.batchSize || 32,
      learningRate: options.learningRate || 0.01
    };
    
    // 本地模型參數
    this.localModel = this._initModel();
    
    // 全局模型版本
    this.globalModelVersion = 0;
    
    // 參與者列表
    this.participants = new Map();
    
    // 訓練進度
    this.trainingProgress = 0;
    
    // GossipSub 用於交換模型更新
    this.gossip = null;
  }
  
  /**
   * 初始化本地模型 (Enhanced Hash Embedding)
   */
  _initModel() {
    const { embeddingDim } = this.modelConfig;
    return {
      // Hash Embedding 層
      embedding: {},
      // 預測頭
      predictionHead: Array(embeddingDim).fill(0).map(() => Math.random() * 0.01),
      // 版本
      version: this.globalModelVersion
    };
  }
  
  /**
   * 啟動聯邦學習
   */
  async start() {
    // 初始化 GossipSub
    this.gossip = new GossipSub(this.libp2p, {
      topics: ['fed learning/model_update', 'fed learning/aggregate'],
      messageCacheGcTimeout: 300000
    });
    
    await this.gossip.start();
    
    // 訂閱主題
    await this.gossip.subscribe('fed learning/model_update');
    await this.gossip.subscribe('fed learning/aggregate');
    
    // 處理傳入消息
    this.gossip.on('fed learning:model_update', this._handleModelUpdate.bind(this));
    this.gossip.on('fed learning:aggregate', this._handleAggregate.bind(this));
    
    console.log(`[FederatedLearning] Started on peer ${this.peerId.slice(0, 8)}`);
  }
  
  /**
   * 本地訓練
   * @param {Array} localData - 本地數據 (不上傳)
   */
  async trainLocal(localData) {
    console.log(`[FederatedLearning] Starting local training with ${localData.length} samples`);
    
    for (let epoch = 0; epoch < this.modelConfig.local_epochs; epoch++) {
      // 本地梯度下降
      for (const sample of localData) {
        // Enhanced Hash Embedding: 使用 hash 作為 embedding key
        const hashKey = createHash('sha256').update(sample.id).digest('hex').slice(0, 16);
        
        if (!this.localModel.embedding[hashKey]) {
          // 初始化 hash embedding
          this.localModel.embedding[hashKey] = Array(this.modelConfig.embeddingDim)
            .fill(0).map(() => Math.random() * 0.01);
        }
        
        // 簡化的梯度更新 (本地完成，不上傳原始數據)
        const gradient = this._computeGradient(sample, this.localModel.embedding[hashKey]);
        this.localModel.embedding[hashKey] = this.localModel.embedding[hashKey].map(
          (v, i) => v - this.modelConfig.learningRate * gradient[i]
        );
      }
      
      this.trainingProgress = ((epoch + 1) / this.modelConfig.local_epochs) * 100;
      this.emit('progress', this.trainingProgress);
    }
    
    // 生成模型參數增量 (delta)
    const modelDelta = this._generateModelDelta();
    console.log(`[FederatedLearning] Local training complete, generated delta v${modelDelta.version}`);
    
    return modelDelta;
  }
  
  /**
   * 計算梯度 (本地)
   */
  _computeGradient(sample, embedding) {
    // 簡化的梯度計算
    const prediction = embedding.reduce((sum, v, i) => sum + v * this.localModel.predictionHead[i], 0);
    const error = sample.label - prediction;
    return embedding.map(v => error * v * 0.1);
  }
  
  /**
   * 生成模型增量
   */
  _generateModelDelta() {
    const delta = {
      peerId: this.peerId,
      version: this.globalModelVersion,
      timestamp: Date.now(),
      embeddingKeys: Object.keys(this.localModel.embedding),
      // 壓縮後的 embedding 增量
      embeddingDelta: Object.fromEntries(
        Object.entries(this.localModel.embedding).map(([k, v]) => [
          k, v.map(val => Math.round(val * 10000) / 10000) // 4位小數壓縮
        ])
      )
    };
    
    // 生成增量哈希
    const deltaHash = createHash('sha256')
      .update(JSON.stringify(delta))
      .digest('hex');
    
    return { ...delta, deltaHash };
  }
  
  /**
   * 廣播模型增量 (通過 GossipSub)
   */
  async broadcastModelUpdate(delta) {
    // 使用 Post-Quantum Crypto 加密參數
    const { PostQuantumCrypto } = await import('./post-quantum-crypto.js');
    const encryptedDelta = await PostQuantumCrypto.encrypt(
      JSON.stringify(delta),
      this.peerId
    );
    
    await this.gossip.publish('fed learning:model_update', {
      encryptedDelta,
      version: this.globalModelVersion
    });
    
    console.log(`[FederatedLearning] Broadcast model delta`);
  }
  
  /**
   * 處理收到的模型更新
   */
  async _handleModelUpdate(message) {
    const { encryptedDelta, version } = message;
    
    // 解密
    const { PostQuantumCrypto } = await import('./post-quantum-crypto.js');
    const delta = JSON.stringify(await PostQuantumCrypto.decrypt(
      encryptedDelta,
      this.peerId
    ));
    
    // 驗證增量有效性
    if (!this._verifyDelta(delta)) {
      console.warn(`[FederatedLearning] Invalid delta received`);
      return;
    }
    
    // 暫存參與者增量
    this.participants.set(delta.peerId, delta);
    
    // 檢查是否達到聚合閾值
    if (this.participants.size >= 3) {
      await this._requestAggregation();
    }
  }
  
  /**
   * 驗證增量
   */
  _verifyDelta(delta) {
    const hash = createHash('sha256')
      .update(JSON.stringify({ ...delta, deltaHash: undefined }))
      .digest('hex');
    return hash === delta.deltaHash;
  }
  
  /**
   * 請求聚合 (通過 DAO Governance)
   */
  async _requestAggregation() {
    const { DAOGovernance } = await import('./dao-governance.js');
    
    // 提交聚合提案
    const proposal = await DAOGovernance.propose({
      title: 'Federated Model Aggregation',
      description: `Aggregate ${this.participants.size} participant models`,
      votingPeriod: '1d'
    });
    
    // 等待 DAO 投票通過
    DAOGovernance.on('proposal:passed', async () => {
      await this._aggregateModels();
    });
  }
  
  /**
   * 聚合模型 (FedAvg)
   */
  async _aggregateModels() {
    const participants = Array.from(this.participants.values());
    const totalWeight = participants.length;
    
    // 加權平均聚合
    const aggregatedEmbedding = {};
    
    for (const participant of participants) {
      const weight = 1 / totalWeight;
      
      for (const [key, embedding] of Object.entries(participant.embeddingDelta)) {
        if (!aggregatedEmbedding[key]) {
          aggregatedEmbedding[key] = Array(embedding.length).fill(0);
        }
        
        aggregatedEmbedding[key] = aggregatedEmbedding[key].map(
          (v, i) => v + embedding[i] * weight
        );
      }
    }
    
    // 更新全局模型
    this.localModel.embedding = aggregatedEmbedding;
    this.globalModelVersion++;
    this.localModel.version = this.globalModelVersion;
    
    // 廣播聚合結果
    await this.gossip.publish('fed learning:aggregate', {
      globalModelVersion: this.globalModelVersion,
      participantCount: participants.size
    });
    
    // 清空參與者
    this.participants.clear();
    
    console.log(`[FederatedLearning] Aggregated to global model v${this.globalModelVersion}`);
    this.emit('aggregated', { version: this.globalModelVersion });
  }
  
  /**
   * 處理聚合消息
   */
  _handleAggregate(message) {
    if (message.globalModelVersion > this.globalModelVersion) {
      this.globalModelVersion = message.globalModelVersion;
      // 下載並應用全局模型
      this._downloadGlobalModel();
    }
  }
  
  /**
   * 下載全局模型
   */
  async _downloadGlobalModel() {
    // 從鄰居節點獲取最新全局模型
    // 實現略 (通過 DHT 查詢)
    console.log(`[FederatedLearning] Updated to global model v${this.globalModelVersion}`);
    this.emit('modelUpdated', { version: this.globalModelVersion });
  }
  
  /**
   * 獲取預測結果
   */
  predict(input) {
    const hashKey = createHash('sha256').update(input.id).digest('hex').slice(0, 16);
    const embedding = this.localModel.embedding[hashKey] || 
                      Array(this.modelConfig.embeddingDim).fill(0);
    
    return embedding.reduce((sum, v, i) => sum + v * this.localModel.predictionHead[i], 0);
  }
  
  /**
   * 停止
   */
  async stop() {
    if (this.gossip) {
      await this.gossip.stop();
    }
    console.log(`[FederatedLearning] Stopped`);
  }
}

module.exports = { FederatedEdgeLearning };
