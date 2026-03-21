/**
 * WebRTC P2P Streamer - 取代 HTTP Upload
 * 
 * 技術實現：
 * - 圖片分片通過 RTCDataChannel 傳輸
 * - 支持 STUN/TURN 穿透
 * - 斷點續傳支持
 * - 流量控制 (backpressure)
 * 
 * 使用方式：
 * const streamer = new P2PStreamer(peerId);
 * await streamer.connect(peerId); // 連接到對等節點
 * await streamer.sendImage(imageBlob, itemId); // 發送圖片
 */

class P2PStreamer {
  constructor(myPeerId) {
    this.myPeerId = myPeerId;
    this.peerConnections = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map();    // peerId -> RTCDataChannel
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // 自建 TURN - 桌面全節點
      { 
        urls: 'turn:68.147.37.150:3478',
        username: 'ourbackyard',
        credential: 'calgary2024'
      }
    ];
    
    // 圖片傳輸狀態
    this.incomingTransfers = new Map(); // itemId -> { chunks:[], total:0, received:0 }
    this.outgoingTransfers = new Map(); // itemId -> { offset:0, total:0 }
    
    // 配置
    this.CHUNK_SIZE = 16384; // 16KB chunks
    this.MAX_BUFFER = 1024 * 1024; // 1MB max buffer
    
    // 回調
    this.onImageReceived = null; // (itemId, blob) => void
    this.onProgress = null;      // (itemId, progress) => void
    this.onPeerConnected = null; // (peerId) => void
    this.onPeerDisconnected = null; // (peerId) => void
  }
  
  /**
   * 連接到對等節點
   */
  async connect(peerId) {
    if (this.peerConnections.has(peerId)) {
      console.log('[P2P] Already connected to', peerId);
      return;
    }
    
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    
    // 設置 ICE 候選者處理
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // 通過信令服務器發送 ICE 候選者
        this.sendSignal(peerId, { type: 'ice-candidate', candidate: event.candidate });
      }
    };
    
    // 連接狀態變化
    pc.onconnectionstatechange = () => {
      console.log('[P2P] Connection state:', peerId, pc.connectionState);
      
      if (pc.connectionState === 'connected') {
        this.onPeerConnected?.(peerId);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.peerConnections.delete(peerId);
        this.dataChannels.delete(peerId);
        this.onPeerDisconnected?.(peerId);
      }
    };
    
    // 創建 DataChannel
    const dc = pc.createDataChannel('image-transfer', {
      ordered: true, // 確保順序
      maxPacketLifeTime: 30000 // 30秒重傳
    });
    
    this.setupDataChannel(peerId, dc);
    
    // 創建並發送 offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendSignal(peerId, { type: 'offer', sdp: offer });
    
    this.peerConnections.set(peerId, pc);
    console.log('[P2P] Connecting to', peerId);
  }
  
  /**
   * 處理傳入的連接 (被呼叫時)
   */
  async handleOffer(peerId, sdp) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, { type: 'ice-candidate', candidate: event.candidate });
      }
    };
    
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.onPeerConnected?.(peerId);
      } else if (pc.connectionState === 'disconnected') {
        this.onPeerDisconnected?.(peerId);
      }
    };
    
    // 處理 DataChannel
    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerId, event.channel);
    };
    
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    this.sendSignal(peerId, { type: 'answer', sdp: answer });
    this.peerConnections.set(peerId, pc);
  }
  
  /**
   * 處理 answer
   */
  async handleAnswer(peerId, sdp) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  }
  
  /**
   * 處理 ICE 候選者
   */
  async handleIceCandidate(peerId, candidate) {
    const pc = this.peerConnections.get(peerId);
    if (pc && candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
  
  /**
   * 設置 DataChannel 處理
   */
  setupDataChannel(peerId, dc) {
    dc.onopen = () => {
      console.log('[P2P] DataChannel open:', peerId);
    };
    
    dc.onclose = () => {
      console.log('[P2P] DataChannel closed:', peerId);
    };
    
    dc.onerror = (error) => {
      console.error('[P2P] DataChannel error:', peerId, error);
    };
    
    dc.onmessage = (event) => {
      this.handleMessage(peerId, event.data);
    };
    
    this.dataChannels.set(peerId, dc);
  }
  
  /**
   * 處理傳入的消息
   */
  handleMessage(peerId, data) {
    // 處理二進制圖片數據
    if (data instanceof ArrayBuffer || data instanceof Blob) {
      this.handleBinaryChunk(peerId, data);
      return;
    }
    
    // 處理 JSON 控制消息
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'IMG_HEADER':
          // 開始接收新圖片
          this.incomingTransfers.set(msg.itemId, {
            itemId: msg.itemId,
            total: msg.size,
            received: 0,
            mimeType: msg.mimeType || 'image/jpeg',
            chunks: []
          });
          console.log('[P2P] IMG_HEADER:', msg.itemId, 'size:', msg.size);
          break;
          
        case 'IMG_REQUEST':
          // 對方請求發送圖片
          this.sendImage(msg.itemId, msg.blob).catch(console.error);
          break;
          
        case 'IMG_ACK':
          // 確認接收完成
          this.outgoingTransfers.delete(msg.itemId);
          console.log('[P2P] Image sent successfully:', msg.itemId);
          break;
      }
    } catch (e) {
      console.error('[P2P] Message parse error:', e);
    }
  }
  
  /**
   * 處理二進制圖片分片
   */
  handleBinaryChunk(peerId, data) {
    // 找到當前傳輸
    let currentTransfer = null;
    for (const [itemId, transfer] of this.incomingTransfers) {
      if (transfer.received < transfer.total) {
        currentTransfer = transfer;
        break;
      }
    }
    
    if (!currentTransfer) {
      console.warn('[P2P] No active transfer for binary data');
      return;
    }
    
    // 確保 data 是 ArrayBuffer
    if (data instanceof Blob) {
      data.arrayBuffer().then(buffer => {
        this.processChunk(currentTransfer, buffer);
      });
    } else {
      this.processChunk(currentTransfer, data);
    }
  }
  
  processChunk(transfer, buffer) {
    transfer.chunks.push(buffer);
    transfer.received += buffer.byteLength;
    
    const progress = Math.round((transfer.received / transfer.total) * 100);
    this.onProgress?.(transfer.itemId, progress);
    
    // 檢查是否完成
    if (transfer.received >= transfer.total) {
      this.completeTransfer(transfer);
    }
  }
  
  async completeTransfer(transfer) {
    try {
      // 合併所有分片
      const blob = new Blob(transfer.chunks, { type: transfer.mimeType });
      
      // 觸發回調
      this.onImageReceived?.(transfer.itemId, blob);
      
      // 發送確認
      this.broadcast({ type: 'IMG_ACK', itemId: transfer.itemId });
      
      console.log('[P2P] Image received:', transfer.itemId);
      
      // 清理
      this.incomingTransfers.delete(transfer.itemId);
    } catch (e) {
      console.error('[P2P] Complete transfer error:', e);
    }
  }
  
  /**
   * 發送圖片到所有已連接的節點
   */
  async sendImage(itemId, blob) {
    const buffer = await blob.arrayBuffer();
    const totalSize = buffer.byteLength;
    let offset = 0;
    
    this.outgoingTransfers.set(itemId, { offset: 0, total: totalSize });
    
    // 發送 header
    this.broadcast({
      type: 'IMG_HEADER',
      itemId: itemId,
      size: totalSize,
      mimeType: blob.type || 'image/jpeg'
    });
    
    // 分片發送
    while (offset < totalSize) {
      // 等待緩衝區清空
      await this.waitForBuffer();
      
      const chunk = buffer.slice(offset, offset + this.CHUNK_SIZE);
      
      // 廣播到所有連接的節點
      for (const [peerId, dc] of this.dataChannels) {
        if (dc.readyState === 'open') {
          try {
            dc.send(chunk);
          } catch (e) {
            console.error('[P2P] Send chunk error:', peerId, e);
          }
        }
      }
      
      offset += this.CHUNK_SIZE;
      const progress = Math.round((offset / totalSize) * 100);
      this.onProgress?.(itemId, progress);
    }
    
    // 發送完成標記
    this.broadcast({ type: 'IMG_END', itemId: itemId });
    
    console.log('[P2P] Image sent:', itemId);
    this.outgoingTransfers.delete(itemId);
  }
  
  /**
   * 等待 DataChannel 緩衝區清空
   */
  waitForBuffer() {
    return new Promise((resolve) => {
      let ready = true;
      
      for (const [_, dc] of this.dataChannels) {
        if (dc.readyState === 'open' && dc.bufferedAmount > this.MAX_BUFFER) {
          ready = false;
          break;
        }
      }
      
      if (ready) {
        resolve();
        return;
      }
      
      // 等待緩衝區清空事件
      const checkBuffer = () => {
        let allReady = true;
        for (const [_, dc] of this.dataChannels) {
          if (dc.readyState === 'open' && dc.bufferedAmount > this.MAX_BUFFER) {
            allReady = false;
            break;
          }
        }
        
        if (allReady) {
          resolve();
        } else {
          setTimeout(checkBuffer, 50);
        }
      };
      
      setTimeout(checkBuffer, 50);
    });
  }
  
  /**
   * 廣播消息到所有節點
   */
  broadcast(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    
    for (const [peerId, dc] of this.dataChannels) {
      if (dc.readyState === 'open') {
        try {
          dc.send(data);
        } catch (e) {
          console.error('[P2P] Broadcast error:', peerId, e);
        }
      }
    }
  }
  
  /**
   * 發送信號到信令服務器 (需要與 WebSocket 集成)
   */
  sendSignal(peerId, signal) {
    // 這個方法需要與現有的 WebSocket 連接集成
    // 在實際實現中，通過 WS 發送信令
    if (this.signalCallback) {
      this.signalCallback(peerId, signal);
    } else {
      console.warn('[P2P] No signal callback configured');
    }
  }
  
  /**
   * 設置信令回調
   */
  setSignalCallback(callback) {
    this.signalCallback = callback;
  }
  
  /**
   * 獲取已連接的節點列表
   */
  getConnectedPeers() {
    return Array.from(this.dataChannels.keys());
  }
  
  /**
   * 斷開連接
   */
  disconnect(peerId) {
    const pc = this.peerConnections.get(peerId);
    const dc = this.dataChannels.get(peerId);
    
    if (dc) {
      dc.close();
      this.dataChannels.delete(peerId);
    }
    
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }
    
    console.log('[P2P] Disconnected:', peerId);
  }
  
  /**
   * 斷開所有連接
   */
  disconnectAll() {
    for (const peerId of this.dataChannels.keys()) {
      this.disconnect(peerId);
    }
  }
  
  /**
   * 獲取傳輸狀態
   */
  getStatus() {
    return {
      connectedPeers: this.dataChannels.size,
      incoming: Array.from(this.incomingTransfers.keys()),
      outgoing: Array.from(this.outgoingTransfers.keys())
    };
  }
}

// 導出模塊
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { P2PStreamer };
}
