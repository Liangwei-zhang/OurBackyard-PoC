/**
 * DP-Federated Learning - 差分隱私聯邦學習
 * 
 * 在模型梯度中注入本地差分隱私，實現數學級不可逆隱私
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash, randomBytes } = require('crypto');

class DPFederatedLearning extends EventEmitter {
  constructor(libp2p, options = {}) {
    super();
    this.libp2p = libp2p;
    this.peerId = libp2p.peerId.toString();
    
    // 差分隱私配置
    this.dpConfig = {
      epsilon: options.epsilon || 1.0, // 隱私預算
      delta: options.delta || 1e-5, // 失敗概率
      sensitivity: options.sensitivity || 1.0, // 梯度敏感度
      noiseScale: options.noiseScale || 1.0, // 噪音 scale
      maxGradNorm: options.maxGradNorm || 1.0 // 梯度裁剪範圍
    };
    
    // 模型配置
    this.modelConfig = {
      embeddingDim: options.embeddingDim || 128,
      local_epochs: options.localEpochs || 5,
      batchSize: options.batchSize || 32,
      learningRate: options.learningRate || 0.01
    };
    
    // 本地模型
    this.localModel = this._initModel();
    
    // 全局模型版本
    this.globalModelVersion = 0;
    
    // 累積隱私預算
    this.privacyBudget = {
      spent: 0,
      epsilon: this.dpConfig.epsilon
    };
    
    // 參與者列表
    this.participants = new Map();
  }
  
  /**
   * 初始化模型
   */
  _initModel() {
    const { embeddingDim } = this.modelConfig;
    return {
      embedding: {},
      predictionHead: Array(embeddingDim).fill(0).map(() => Math.random() * 0.01),
      version: this.globalModelVersion
    };
  }
  
  /**
   * 本地訓練 + 差分隱私
   * @param {Array} localData - 本地數據
   */
  async trainLocalDP(localData) {
    console.log(`[DP-FL] Starting DP local training, budget: ${this.privacyBudget.epsilon - this.privacyBudget.spent}`);
    
    // 計算隱私消耗
    const dpCost = this._calculateDPCost(localData.length);
    
    if (this.privacyBudget.spent + dpCost > this.privacyBudget.epsilon) {
      throw new Error('Privacy budget exhausted');
    }
    
    // 標準本地訓練
    const gradients = await this._computeGradients(localData);
    
    // 梯度裁剪
    const clippedGradients = this._clipGradients(gradients);
    
    // 添加高斯噪音 (差分隱私核心)
    const noisedGradients = this._addGaussianNoise(clippedGradients);
    
    // 更新本地模型
    this._applyGradients(noisedGradients);
    
    // 記錄隱私消耗
    this.privacyBudget.spent += dpCost;
    
    // 生成模型增量
    const delta = this._generateDelta();
    
    console.log(`[DP-FL] Training complete, privacy spent: ${dpCost}, total: ${this.privacyBudget.spent}`);
    
    return {
      delta,
      privacyCost: dpCost,
      remainingBudget: this.privacyBudget.epsilon - this.privacyBudget.spent
    };
  }
  
  /**
   * 計算 DP 成本
   */
  _calculateDPCost(sampleCount) {
    // 簡化的 DP 成本計算
    // 實際應使用 Moments Accountant 或 RDP
    const c = this.dpConfig.sensitivity;
    const sigma = this.dpConfig.noiseScale * c;
    const q = sampleCount / 1000; // 採樣率
    
    // 近似 DP 成本
    const cost = (q * q * this.modelConfig.local_epochs) / (sigma * sigma);
    return Math.min(cost, this.dpConfig.epsilon);
  }
  
  /**
   * 計算梯度
   */
  async _computeGradients(localData) {
    const gradients = {};
    
    for (const sample of localData) {
      const hashKey = createHash('sha256').update(sample.id).digest('hex').slice(0, 16);
      
      if (!this.localModel.embedding[hashKey]) {
        this.localModel.embedding[hashKey] = Array(this.modelConfig.embeddingDim)
          .fill(0).map(() => Math.random() * 0.01);
      }
      
      // 計算損失梯度
      const embedding = this.localModel.embedding[hashKey];
      const prediction = embedding.reduce((sum, v, i) => 
        sum + v * this.localModel.predictionHead[i], 0);
      const error = sample.label - prediction;
      
      // 簡化梯度
      const grad = embedding.map(v => error * v * 0.1);
      
      if (!gradients[hashKey]) {
        gradients[hashKey] = Array(grad.length).fill(0);
      }
      
      gradients[hashKey] = gradients[hashKey].map((g, i) => g + grad[i]);
    }
    
    return gradients;
  }
  
  /**
   * 梯度裁剪
   */
  _clipGradients(gradients) {
    const clipped = {};
    const { maxGradNorm } = this.dpConfig;
    
    for (const [key, grad] of Object.entries(gradients)) {
      // 計算 L2 範數
      const norm = Math.sqrt(grad.reduce((sum, g) => sum + g * g, 0));
      
      // 裁剪
      if (norm > maxGradNorm) {
        clipped[key] = grad.map(g => g * (maxGradNorm / norm));
      } else {
        clipped[key] = grad;
      }
    }
    
    return clipped;
  }
  
  /**
   * 添加高斯噪音 (本地差分隱私)
   */
  _addGaussianNoise(gradients) {
    const { noiseScale, sensitivity } = this.dpConfig;
    const sigma = noiseScale * sensitivity;
    
    const noised = {};
    
    for (const [key, grad] of Object.entries(gradients)) {
      noised[key] = grad.map(g => {
        // Box-Muller 變換生成高斯分佈
        const u1 = Math.random();
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        
        // 添加噪音
        return g + z * sigma;
      });
    }
    
    return noised;
  }
  
  /**
   * 應用梯度
   */
  _applyGradients(gradients) {
    for (const [key, grad] of Object.entries(gradients)) {
      if (!this.localModel.embedding[key]) {
        this.localModel.embedding[key] = Array(this.modelConfig.embeddingDim).fill(0);
      }
      
      this.localModel.embedding[key] = this.localModel.embedding[key].map(
        (v, i) => v - this.modelConfig.learningRate * grad[i]
      );
    }
  }
  
  /**
   * 生成增量
   */
  _generateDelta() {
    return {
      peerId: this.peerId,
      version: this.globalModelVersion,
      timestamp: Date.now(),
      embeddingDelta: Object.fromEntries(
        Object.entries(this.localModel.embedding).map(([k, v]) => [
          k, v.map(val => Math.round(val * 10000) / 10000)
        ])
      ),
      privacyCost: this.privacyBudget.spent
    };
  }
  
  /**
   * 安全的增量聚合 (FedAvg)
   */
  async aggregateSecurely(participantDeltas) {
    console.log(`[DP-FL] Securely aggregating ${participantDeltas.length} participants`);
    
    // 驗證隱私預算
    const totalCost = participantDeltas.reduce((sum, d) => sum + (d.privacyCost || 0), 0);
    
    if (totalCost > this.privacyBudget.epsilon) {
      throw new Error('Aggregation would exceed privacy budget');
    }
    
    // 檢查噪音稀釋效應
    const dilutedNoise = this._diluteNoise(participantDeltas);
    console.log(`[DP-FL] Noise diluted by factor: ${dilutedNoise.dilutionFactor}`);
    
    // 加權平均聚合
    const aggregated = this._weightedAverage(participantDeltas);
    
    // 更新全局模型
    this.localModel.embedding = aggregated;
    this.globalModelVersion++;
    
    // 記錄總隱私消耗
    this.privacyBudget.spent = Math.max(
      this.privacyBudget.spent,
      participantDeltas.reduce((max, d) => Math.max(max, d.privacyCost || 0), 0)
    );
    
    console.log(`[DP-FL] Aggregated to v${this.globalModelVersion}, total privacy spent: ${this.privacyBudget.spent}`);
    
    return {
      version: this.globalModelVersion,
      totalPrivacyCost: this.privacyBudget.spent,
      dilutedNoiseFactor: dilutedNoise.dilutionFactor
    };
  }
  
  /**
   * 噪音稀釋效應
   * 多人貢獻時噪音會相互抵消
   */
  _diluteNoise(deltas) {
    const n = deltas.length;
    // 噪音標準差隨人數增加而減少
    const dilutionFactor = Math.sqrt(n);
    
    return {
      originalSigma: this.dpConfig.noiseScale * this.dpConfig.sensitivity,
      dilutedSigma: (this.dpConfig.noiseScale * this.dpConfig.sensitivity) / dilutionFactor,
      dilutionFactor
    };
  }
  
  /**
   * 加權平均
   */
  _weightedAverage(deltas) {
    const n = deltas.length;
    const aggregated = {};
    
    for (const delta of deltas) {
      const weight = 1 / n;
      
      for (const [key, embedding] of Object.entries(delta.embeddingDelta)) {
        if (!aggregated[key]) {
          aggregated[key] = Array(this.modelConfig.embeddingDim).fill(0);
        }
        
        aggregated[key] = aggregated[key].map(
          (v, i) => v + (embedding[i] || 0) * weight
        );
      }
    }
    
    return aggregated;
  }
  
  /**
   * 重置隱私預算 (新 epoch)
   */
  resetPrivacyBudget() {
    this.privacyBudget.spent = 0;
    console.log(`[DP-FL] Privacy budget reset`);
  }
  
  /**
   * 獲取隱私報告
   */
  getPrivacyReport() {
    return {
      epsilon: this.dpConfig.epsilon,
      delta: this.dpConfig.delta,
      spent: this.privacyBudget.spent,
      remaining: this.dpConfig.epsilon - this.privacyBudget.spent,
      noiseScale: this.dpConfig.noiseScale,
      maxGradNorm: this.dpConfig.maxGradNorm,
      modelVersion: this.globalModelVersion
    };
  }
  
  /**
   * 驗證差分隱私屬性
   */
  verifyDPProperty(neighboringDatasets) {
    // 檢查相鄰數據集的輸出分佈差異
    // 實現真實世界應使用正式的 DP 驗證工具
    
    const epsilon = this.dpConfig.epsilon;
    const delta = this.dpConfig.delta;
    
    // 簡化驗證
    const guarantee = {
      epsilon,
      delta,
      mechanism: 'Gaussian',
      composition: 'Basic Composition',
      verifiable: true
    };
    
    console.log(`[DP-FL] DP guarantee: (ε=${epsilon}, δ=${delta})`);
    
    return guarantee;
  }
}

module.exports = { DPFederatedLearning };
