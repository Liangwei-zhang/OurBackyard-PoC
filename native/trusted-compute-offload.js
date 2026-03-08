/**
 * Trusted Compute Offload - 可信算力卸載
 * 
 * 將重計算任務卸載給社區內的可信計算節點
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash, randomBytes } = require('crypto');

class TrustedComputeOffload extends EventEmitter {
  constructor(libp2p, options = {}) {
    super();
    this.libp2p = libp2p;
    this.peerId = libp2p.peerId?.toString() || 'unknown';
    
    // 配置
    this.config = {
      // 任務類型
      supportedTasks: options.supportedTasks || [
        'zk_proof',
        'llm_inference',
        'image_processing',
        'data_aggregation'
      ],
      
      // 計算節點要求
      minReputation: options.minReputation || 50,
      minComputePower: options.minComputePower || 1000, // GFLOPS
      
      // 卸載參數
      maxLatency: options.maxLatency || 30000, // 30秒
      taskTimeout: options.taskTimeout || 60000, // 60秒
      
      // 安全參數
      encryptionEnabled: options.encryptionEnabled !== false,
      resultVerification: options.resultVerification !== false
    };
    
    // 計算節點註冊表
    this.computeNodes = new Map();
    
    // 任務隊列
    this.taskQueue = new Map();
    
    // 結果緩存
    this.resultCache = new Map();
    
    // 我的計算能力 (如果是計算節點)
    this.myComputePower = options.computePower || 0;
    this.isComputeNode = options.isComputeNode || false;
    
    // 統計
    this.stats = {
      tasksSubmitted: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      totalComputeUsed: 0
    };
  }
  
  /**
   * 註冊為計算節點
   * @param {Object} capabilities - 計算能力
   */
  registerAsComputeNode(capabilities) {
    this.isComputeNode = true;
    this.myComputePower = capabilities.gflops || 1000;
    
    const nodeInfo = {
      peerId: this.peerId,
      capabilities,
      gflops: this.myComputePower,
      status: 'online',
      registeredAt: Date.now(),
      lastActive: Date.now(),
      tasksCompleted: 0,
      reputation: 100
    };
    
    this.computeNodes.set(this.peerId, nodeInfo);
    
    console.log(`[Compute] Registered as compute node, ${this.myComputePower} GFLOPS`);
    
    return nodeInfo;
  }
  
  /**
   * 提交計算任務
   * @param {string} taskType - 任務類型
   * @param {Object} inputData - 輸入數據
   * @param {Object} options - 選項
   */
  async submitTask(taskType, inputData, options = {}) {
    if (!this.config.supportedTasks.includes(taskType)) {
      throw new Error(`Unsupported task type: ${taskType}`);
    }
    
    const taskId = createHash('sha256')
      .update(Date.now() + this.peerId + randomBytes(8).toString('hex'))
      .digest('hex').slice(0, 16);
    
    const task = {
      id: taskId,
      type: taskType,
      inputData,
      options: {
        priority: options.priority || 'normal',
        timeout: options.timeout || this.config.taskTimeout,
        verification: options.verification !== false,
        ...options
      },
      status: 'pending',
      createdAt: Date.now(),
      submittedBy: this.peerId,
      assignedTo: null,
      result: null,
      error: null
    };
    
    this.taskQueue.set(taskId, task);
    this.stats.tasksSubmitted++;
    
    // 選擇最佳計算節點
    const node = await this._selectComputeNode(taskType, options);
    
    if (node) {
      task.assignedTo = node.peerId;
      task.status = 'assigned';
      
      // 發送任務
      await this._dispatchTask(task, node);
    } else {
      // 排隊等待
      task.status = 'queued';
      this._enqueueTask(task);
    }
    
    console.log(`[Compute] Task ${taskId} submitted, type: ${taskType}`);
    
    // 返回 Promise
    return new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
      
      // 超時處理
      setTimeout(() => {
        if (task.status === 'pending' || task.status === 'assigned') {
          task.status = 'timeout';
          task.error = 'Task timeout';
          this.stats.tasksFailed++;
          reject(new Error('Task timeout'));
        }
      }, task.options.timeout);
    });
  }
  
  /**
   * 選擇計算節點
   */
  async _selectComputeNode(taskType, options) {
    const candidates = [];
    
    for (const [peerId, node] of this.computeNodes) {
      if (peerId === this.peerId) continue;
      if (node.status !== 'online') continue;
      if (node.reputation < this.config.minReputation) continue;
      if (node.gflops < this.config.minComputePower) continue;
      
      // 檢查任務類型支持
      if (!node.capabilities.supportedTasks?.includes(taskType)) continue;
      
      candidates.push(node);
    }
    
    if (candidates.length === 0) return null;
    
    // 選擇最高評分的節點
    candidates.sort((a, b) => {
      const scoreA = a.reputation * a.gflops;
      const scoreB = b.reputation * b.gflops;
      return scoreB - scoreA;
    });
    
    return candidates[0];
  }
  
  /**
   * 分發任務
   */
  async _dispatchTask(task, node) {
    // 加密輸入數據
    let encryptedInput = task.inputData;
    
    if (this.config.encryptionEnabled) {
      encryptedInput = this._encryptData(task.inputData, node.peerId);
    }
    
    // 模擬發送 (實際需要通過 libp2p)
    this.emit('task:dispatch', {
      taskId: task.id,
      nodeId: node.peerId,
      inputHash: createHash('sha256').update(JSON.stringify(task.inputData)).digest('hex')
    });
    
    // 模擬計算延遲
    const estimatedTime = this._estimateComputeTime(task.type, task.inputData);
    const actualTime = Math.min(estimatedTime * 1000, task.options.timeout - 1000);
    
    setTimeout(async () => {
      try {
        // 執行計算 (本地模擬)
        const result = await this._executeLocally(task.type, task.inputData);
        
        // 驗證結果
        if (task.options.verification && this.config.resultVerification) {
          const verified = await this._verifyResult(task, result);
          if (!verified) {
            throw new Error('Result verification failed');
          }
        }
        
        task.status = 'completed';
        task.result = result;
        task.completedAt = Date.now();
        
        // 緩存結果
        this.resultCache.set(task.id, {
          result,
          timestamp: Date.now()
        });
        
        // 更新節點統計
        node.tasksCompleted++;
        node.lastActive = Date.now();
        
        this.stats.tasksCompleted++;
        this.stats.totalComputeUsed += estimatedTime;
        
        if (task.resolve) {
          task.resolve(result);
        }
        
        this.emit('task:completed', { taskId: task.id, nodeId: node.peerId });
        
      } catch (error) {
        task.status = 'failed';
        task.error = error.message;
        
        // 降低節點評分
        node.reputation = Math.max(0, node.reputation - 10);
        
        this.stats.tasksFailed++;
        
        if (task.reject) {
          task.reject(error);
        }
        
        this.emit('task:failed', { taskId: task.id, error: error.message });
      }
    }, actualTime);
  }
  
  /**
   * 本地執行計算 (模擬)
   */
  async _executeLocally(taskType, inputData) {
    switch (taskType) {
      case 'zk_proof':
        // 模擬 ZK 證明生成
        await this._simulateWork(100);
        return {
          proof: createHash('sha256').update(JSON.stringify(inputData)).digest('hex'),
          publicInput: inputData.public,
          verified: true
        };
        
      case 'llm_inference':
        // 模擬 LLM 推理
        await this._simulateWork(500);
        return {
          response: 'Processed inference request',
          tokens: Math.floor(Math.random() * 100) + 50,
          model: 'local-llm'
        };
        
      case 'image_processing':
        // 模擬圖像處理
        await this._simulateWork(200);
        return {
          processed: true,
          outputSize: inputData.size || 1024
        };
        
      case 'data_aggregation':
        // 數據聚合
        await this._simulateWork(50);
        return {
          aggregated: true,
          count: Array.isArray(inputData) ? inputData.length : 1,
          result: { sum: 0, avg: 0 }
        };
        
      default:
        throw new Error(`Unknown task type: ${taskType}`);
    }
  }
  
  /**
   * 模擬計算工作
   */
  _simulateWork(durationMs) {
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }
  
  /**
   * 估計計算時間
   */
  _estimateComputeTime(taskType, inputData) {
    const baseTimes = {
      zk_proof: 2, // 秒
      llm_inference: 5,
      image_processing: 2,
      data_aggregation: 0.5
    };
    
    const base = baseTimes[taskType] || 1;
    const sizeFactor = JSON.stringify(inputData).length / 1000;
    
    return base * (1 + sizeFactor * 0.1);
  }
  
  /**
   * 加密數據
   */
  _encryptData(data, targetPeerId) {
    // 簡單加密 (實際需要 proper E2E encryption)
    const encrypted = Buffer.from(JSON.stringify(data)).toString('base64');
    return {
      encrypted,
      target: targetPeerId,
      algorithm: 'AES-256-GCM'
    };
  }
  
  /**
   * 驗證結果
   */
  async _verifyResult(task, result) {
    // 簡化的結果驗證
    // 實際需要零知識驗證
    
    if (!result) return false;
    
    // 類型特定驗證
    switch (task.type) {
      case 'zk_proof':
        return result.verified === true;
      case 'llm_inference':
        return result.response && result.tokens > 0;
      default:
        return true;
    }
  }
  
  /**
   * 入隊等待
   */
  _enqueueTask(task) {
    // 實際實現需要優先級隊列
    console.log(`[Compute] Task ${task.id} queued`);
  }
  
  /**
   * 處理計算節點註冊
   */
  handleNodeRegistration(nodeInfo) {
    if (nodeInfo.peerId === this.peerId) return;
    
    this.computeNodes.set(nodeInfo.peerId, {
      ...nodeInfo,
      status: 'online',
      lastActive: Date.now()
    });
    
    // 嘗試處理排隊任務
    this._processQueue();
    
    console.log(`[Compute] Node registered: ${nodeInfo.peerId}`);
  }
  
  /**
   * 處理隊列
   */
  async _processQueue() {
    for (const [taskId, task] of this.taskQueue) {
      if (task.status !== 'queued') continue;
      
      const node = await this._selectComputeNode(task.type, task.options);
      if (node) {
        task.assignedTo = node.peerId;
        task.status = 'assigned';
        await this._dispatchTask(task, node);
      }
    }
  }
  
  /**
   * 處理節點離線
   */
  handleNodeOffline(peerId) {
    const node = this.computeNodes.get(peerId);
    if (node) {
      node.status = 'offline';
    }
    
    // 重新分配任務
    for (const [taskId, task] of this.taskQueue) {
      if (task.assignedTo === peerId) {
        task.status = 'pending';
        task.assignedTo = null;
        
        // 異步處理每個任務
        this._reassignTask(task).catch(err => {
          console.error(`[Compute] Failed to reassign task ${task.id}:`, err.message);
        });
      }
    }
  }
  
  /**
   * 重新分配任務
   */
  async _reassignTask(task) {
    const newNode = await this._selectComputeNode(task.type, task.options);
    if (newNode) {
      task.assignedTo = newNode.peerId;
      task.status = 'assigned';
      await this._dispatchTask(task, newNode);
    } else {
      task.status = 'queued';
    }
  }
  
  /**
   * 獲取緩存結果
   */
  getCachedResult(taskId) {
    return this.resultCache.get(taskId);
  }
  
  /**
   * 獲取任務狀態
   */
  getTaskStatus(taskId) {
    const task = this.taskQueue.get(taskId);
    if (!task) return null;
    
    return {
      id: task.id,
      type: task.type,
      status: task.status,
      createdAt: task.createdAt,
      assignedTo: task.assignedTo,
      completedAt: task.completedAt,
      error: task.error
    };
  }
  
  /**
   * 獲取計算節點列表
   */
  getComputeNodes() {
    return Array.from(this.computeNodes.values())
      .filter(n => n.status === 'online')
      .sort((a, b) => b.reputation - a.reputation);
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    return {
      ...this.stats,
      queueLength: Array.from(this.taskQueue.values()).filter(t => t.status !== 'completed').length,
      onlineNodes: this.getComputeNodes().length,
      isComputeNode: this.isComputeNode,
      myComputePower: this.myComputePower
    };
  }
  
  /**
   * 健康檢查
   */
  async healthCheck() {
    const nodes = this.getComputeNodes();
    
    return {
      healthy: nodes.length > 0 || this.isComputeNode,
      onlineNodes: nodes.length,
      queueLength: this.stats.tasksSubmitted - this.stats.tasksCompleted,
      avgCompletionTime: this.stats.tasksCompleted > 0 
        ? this.stats.totalComputeUsed / this.stats.tasksCompleted 
        : 0
    };
  }
}

module.exports = { TrustedComputeOffload };
