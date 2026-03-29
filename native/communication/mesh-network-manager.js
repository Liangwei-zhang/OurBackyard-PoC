/**
 * Mesh Network Manager - 網格網絡管理
 * 
 * 技術實現：
 * - 多路徑連接管理
 * - 連接質量評估與切換
 * - 帶寬優化路由
 * - 故障轉移與自癒合
 * 
 * 使用方式：
 * const mesh = new MeshNetworkManager(myPeerId);
 * await mesh.start();
 * mesh.on('peer-connected', (peerId) => {});
 */

class MeshNetworkManager extends EventTarget {
  constructor(myPeerId) {
    super();
    this.myPeerId = myPeerId;
    
    // 連接管理
    this.connections = new Map(); // peerId -> connection info
    this.channels = new Map(); // peerId -> RTCDataChannel
    
    // 網絡路徑
    this.paths = {
      webrtc: null,     // WebRTC 直連/中繼
      websocket: null,   // WebSocket 備用
      webrtcrelay: null // WebRTC 中繼
    };
    
    // 配置
    this.config = {
      maxConnections: 20,        // 最大連接數
      minConnections: 3,         // 最小保持連接數
      heartbeatInterval: 5000,   // 心跳間隔
      reconnectDelay: 2000,     // 重連延遲
      qualityCheckInterval: 10000 // 質量檢查間隔
    };
    
    // 連接質量
    this.quality = new Map(); // peerId -> quality metrics
    
    // 狀態
    this.isRunning = false;
    this.lastQualityCheck = 0;
  }
  
  /**
   * 初始化並啟動網格網絡
   */
  async start(wsConnection, p2pConnection) {
    console.log('[Mesh] Starting mesh network...');
    
    this.paths.websocket = wsConnection;
    this.paths.webrtc = p2pConnection;
    
    // 設置心跳
    this.startHeartbeat();
    
    // 啟動質量監控
    this.startQualityMonitor();
    
    this.isRunning = true;
    
    console.log('[Mesh] Mesh network started');
    return this;
  }
  
  /**
   * 添加連接
   */
  addConnection(peerId, channel, type = 'webrtc') {
    if (this.connections.size >= this.config.maxConnections) {
      // 移除質量最差的連接
      this.evictWorstConnection();
    }
    
    const connInfo = {
      peerId,
      channel,
      type,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      messagesSent: 0,
      messagesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      latency: 0,
      quality: 'good' // good, medium, poor
    };
    
    this.connections.set(peerId, connInfo);
    this.channels.set(peerId, channel);
    
    // 觸發事件
    this.dispatchEvent(new CustomEvent('peer-connected', { 
      detail: { peerId, type } 
    }));
    
    console.log('[Mesh] Connected to', peerId, 'via', type);
    
    return connInfo;
  }
  
  /**
   * 移除連接
   */
  removeConnection(peerId) {
    const conn = this.connections.get(peerId);
    if (conn) {
      this.connections.delete(peerId);
      this.channels.delete(peerId);
      
      this.dispatchEvent(new CustomEvent('peer-disconnected', { 
        detail: { peerId, reason: conn.disconnectReason || 'unknown' } 
      }));
      
      console.log('[Mesh] Disconnected from', peerId);
      
      // 嘗試重連
      if (!conn.disconnectReason) {
        this.scheduleReconnect(peerId);
      }
    }
  }
  
  /**
   * 發送消息（智能路由）
   */
  async send(peerId, message) {
    const conn = this.connections.get(peerId);
    const channel = this.channels.get(peerId);
    
    if (!channel || channel.readyState !== 'open') {
      // 嘗試通過 WebSocket
      if (this.paths.websocket?.readyState === WebSocket.OPEN) {
        this.paths.websocket.send(JSON.stringify({
          type: 'MESH_MESSAGE',
          target: peerId,
          message
        }));
        return true;
      }
      return false;
    }
    
    try {
      const data = typeof message === 'string' ? message : JSON.stringify(message);
      channel.send(data);
      
      conn.messagesSent++;
      conn.bytesSent += data.length;
      conn.lastActivity = Date.now();
      
      return true;
    } catch (e) {
      console.error('[Mesh] Send error:', peerId, e);
      return false;
    }
  }
  
  /**
   * 廣播消息（多路徑）
   */
  broadcast(message, excludePeerId = null) {
    let sent = 0;
    
    // 通過 WebRTC 發送
    for (const [peerId, channel] of this.channels) {
      if (peerId !== excludePeerId && channel.readyState === 'open') {
        try {
          const data = typeof message === 'string' ? message : JSON.stringify(message);
          channel.send(data);
          sent++;
        } catch (e) {}
      }
    }
    
    // 通過 WebSocket 發送（備用）
    if (this.paths.websocket?.readyState === WebSocket.OPEN) {
      this.paths.websocket.send(JSON.stringify({
        type: 'MESH_BROADCAST',
        message,
        exclude: excludePeerId
      }));
      sent++;
    }
    
    return sent;
  }
  
  /**
   * 獲取最佳路徑
   */
  getBestPath(peerId) {
    const conn = this.connections.get(peerId);
    const channel = this.channels.get(peerId);
    
    if (channel?.readyState === 'open') {
      // WebRTC 可用，檢查質量
      const quality = this.quality.get(peerId);
      if (quality?.latency < 100) {
        return 'webrtc';
      }
    }
    
    // 降級到 WebSocket
    if (this.paths.websocket?.readyState === WebSocket.OPEN) {
      return 'websocket';
    }
    
    return null;
  }
  
  /**
   * 啟動心跳
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeats();
    }, this.config.heartbeatInterval);
  }
  
  /**
   * 發送心跳
   */
  sendHeartbeats() {
    const heartbeat = {
      type: 'MESH_HEARTBEAT',
      from: this.myPeerId,
      timestamp: Date.now()
    };
    
    for (const [peerId, channel] of this.channels) {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify(heartbeat));
        } catch (e) {
          // 連接可能已斷開
          this.handleConnectionError(peerId, e);
        }
      }
    }
  }
  
  /**
   * 處理心跳響應
   */
  handleHeartbeatResponse(peerId, timestamp) {
    const conn = this.connections.get(peerId);
    if (conn) {
      conn.latency = Date.now() - timestamp;
      conn.lastActivity = Date.now();
      
      // 更新質量評估
      this.updateQuality(peerId);
    }
  }
  
  /**
   * 啟動質量監控
   */
  startQualityMonitor() {
    this.qualityInterval = setInterval(() => {
      this.checkQuality();
    }, this.config.qualityCheckInterval);
  }
  
  /**
   * 檢查連接質量
   */
  checkQuality() {
    const now = Date.now();
    
    for (const [peerId, conn] of this.connections) {
      // 檢查是否超時
      if (now - conn.lastActivity > 30000) {
        conn.disconnectReason = 'timeout';
        this.removeConnection(peerId);
        continue;
      }
      
      // 評估質量
      this.updateQuality(peerId);
    }
    
    // 確保最小連接數
    this.ensureMinConnections();
  }
  
  /**
   * 更新連接質量
   */
  updateQuality(peerId) {
    const conn = this.connections.get(peerId);
    if (!conn) return;
    
    let quality = 'good';
    
    // 根據延遲評估
    if (conn.latency > 500) {
      quality = 'poor';
    } else if (conn.latency > 200) {
      quality = 'medium';
    }
    
    // 根據活動評估
    if (conn.messagesSent + conn.messagesReceived === 0) {
      quality = 'medium';
    }
    
    conn.quality = quality;
    this.quality.set(peerId, {
      latency: conn.latency,
      quality,
      messagesPerMinute: (conn.messagesSent + conn.messagesReceived) / (this.config.qualityCheckInterval / 60000)
    });
  }
  
  /**
   * 確保最小連接數
   */
  ensureMinConnections() {
    const activeCount = Array.from(this.channels.values())
      .filter(c => c.readyState === 'open').length;
    
    if (activeCount < this.config.minConnections) {
      console.log('[Mesh] Below minimum connections, requesting peers...');
      // 通過 WebSocket 請求更多節點
      this.paths.websocket?.send(JSON.stringify({
        type: 'MESH_REQUEST_PEERS',
        count: this.config.minConnections - activeCount
      }));
    }
  }
  
  /**
   * 踢出質量最差的連接
   */
  evictWorstConnection() {
    let worst = null;
    let worstQuality = 0;
    
    for (const [peerId, conn] of this.connections) {
      if (conn.quality === 'poor') {
        if (!worst || conn.latency > worstQuality) {
          worst = peerId;
          worstQuality = conn.latency;
        }
      }
    }
    
    if (worst) {
      console.log('[Mesh] Evicting worst connection:', worst);
      this.removeConnection(worst);
    }
  }
  
  /**
   * 處理連接錯誤
   */
  handleConnectionError(peerId, error) {
    const conn = this.connections.get(peerId);
    if (conn) {
      conn.errors = (conn.errors || 0) + 1;
      
      if (conn.errors > 3) {
        conn.disconnectReason = 'too-many-errors';
        this.removeConnection(peerId);
      }
    }
  }
  
  /**
   * 安排重連
   */
  scheduleReconnect(peerId) {
    setTimeout(() => {
      if (this.isRunning && this.connections.size < this.config.maxConnections) {
        console.log('[Mesh] Reconnecting to', peerId);
        this.dispatchEvent(new CustomEvent('request-reconnect', { 
          detail: { peerId } 
        }));
      }
    }, this.config.reconnectDelay);
  }
  
  /**
   * 獲取網絡統計
   */
  getStats() {
    const stats = {
      totalConnections: this.connections.size,
      activeConnections: Array.from(this.channels.values())
        .filter(c => c.readyState === 'open').length,
      paths: {
        webrtc: !!this.paths.webrtc,
        websocket: this.paths.websocket?.readyState === WebSocket.OPEN
      },
      peers: []
    };
    
    for (const [peerId, conn] of this.connections) {
      stats.peers.push({
        peerId,
        type: conn.type,
        quality: conn.quality,
        latency: conn.latency,
        connectedAt: conn.connectedAt
      });
    }
    
    return stats;
  }
  
  /**
   * 停止網格網絡
   */
  stop() {
    this.isRunning = false;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.qualityInterval) {
      clearInterval(this.qualityInterval);
    }
    
    // 關閉所有連接
    for (const [peerId, channel] of this.channels) {
      try {
        channel.close();
      } catch (e) {}
    }
    
    this.connections.clear();
    this.channels.clear();
    
    console.log('[Mesh] Mesh network stopped');
  }
}

// 簡單的 EventTarget 實現
class SimpleEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(callback);
  }
  
  removeEventListener(type, callback) {
    const callbacks = this.listeners.get(type);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index >= 0) callbacks.splice(index, 1);
    }
  }
  
  dispatchEvent(event) {
    const callbacks = this.listeners.get(event.type);
    if (callbacks) {
      callbacks.forEach(cb => cb(event));
    }
  }
}

// 導出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MeshNetworkManager, SimpleEventTarget };
}
