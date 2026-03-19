/**
 * Hole Punching Gateway - 完全 P2P 穿透
 * 
 * 技術實現：
 * - UDP 打洞 + TURN 中繼備份
 * - 桌面全節點作為穿透節點
 * - 自動切換直連/中繼模式
 * - ICE Restarts for NAT changes
 * 
 * 使用方式：
 * const gateway = new HolePunchingGateway(myPeerId);
 * await gateway.init();
 * const connection = await gateway.connect(peerId);
 */

class HolePunchingGateway {
  constructor(myPeerId) {
    this.myPeerId = myPeerId;
    this.connections = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map(); // peerId -> RTCDataChannel
    
    // ICE 服務器配置
    this.iceServers = [
      // STUN - 免費打洞
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      
      // 自建 TURN - 桌面全節點 (Calgary)
      { 
        urls: 'turn:68.147.37.150:3478',
        username: 'ourbackyard',
        credential: 'calgary2024'
      },
      
      // 備用 TURN
      { 
        urls: 'turn:relay.metered.ca:443',
        username: 'openclaw',
        credential: 'openclaw2024'
      }
    ];
    
    // 連接配置
    this.config = {
      iceCandidatePoolSize: 10, // 擴大候選池
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };
    
    // 狀態
    this.connectionStates = new Map(); // peerId -> state
    this.lastConnected = new Map(); // peerId -> timestamp
    
    // 回調
    this.onChannelOpen = null;
    this.onChannelClose = null;
    this.onChannelMessage = null;
    this.onConnectionStateChange = null;
  }
  
  /**
   * 初始化網關
   */
  async init() {
    console.log('[HolePunch] Initializing gateway...');
    
    // 測試 STUN 連接
    await this.testSTUN();
    
    // 開始監聽連接（被動模式）
    this.startPassiveListening();
    
    return this;
  }
  
  /**
   * 測試 STUN 服務器
   */
  async testSTUN() {
    const pc = new RTCPeerConnection({ 
      iceServers: this.iceServers.slice(0, 3) // 只測試 STUN
    });
    
    pc.createDataChannel('test');
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pc.close();
        console.warn('[HolePunch] STUN test timeout');
        resolve(false);
      }, 3000);
      
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const addr = event.candidate.address;
          if (addr && !addr.startsWith('192.168.') && !addr.startsWith('10.') && !addr.startsWith('172.')) {
            // 獲得公網 IP，STUN 可用
            console.log('[HolePunch] STUN working, public IP candidate:', addr);
            clearTimeout(timeout);
            pc.close();
            resolve(true);
          }
        }
      };
    });
  }
  
  /**
   * 開始被動監聽（等待連入）
   */
  startPassiveListening() {
    // 這個方法需要在頁面加載時調用
    // 通過 WS 收到 offer 時調用 handleIncomingOffer
    console.log('[HolePunch] Passive listening ready');
  }
  
  /**
   * 主動連接對等節點（打洞）
   */
  async connect(peerId) {
    if (this.connections.has(peerId)) {
      console.log('[HolePunch] Already connected to', peerId);
      return this.dataChannels.get(peerId);
    }
    
    console.log('[HolePunch] Connecting to', peerId);
    this.connectionStates.set(peerId, 'connecting');
    
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...this.config
    });
    
    // 設置 ICE 候選者收集
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(peerId, event.candidate);
      }
    };
    
    // 連接狀態變化
    pc.onconnectionstatechange = () => {
      this.handleConnectionStateChange(peerId, pc.connectionState);
    };
    
    // DataChannel
    const dc = pc.createDataChannel('data', {
      ordered: true,
      maxPacketLifeTime: 30000
    });
    
    this.setupDataChannel(peerId, dc);
    
    // 創建 offer
    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false
    });
    
    await pc.setLocalDescription(offer);
    
    // 發送 offer 到信令服務器
    this.sendSignalingMessage(peerId, {
      type: 'offer',
      sdp: pc.localDescription
    });
    
    this.connections.set(peerId, pc);
    
    // 設置超時
    setTimeout(() => {
      if (this.connectionStates.get(peerId) === 'connecting') {
        console.warn('[HolePunch] Connection timeout, trying TURN relay...');
        this.forceRelayMode(peerId);
      }
    }, 10000);
    
    return dc;
  }
  
  /**
   * 處理傳入的 offer
   */
  async handleOffer(peerId, sdp) {
    console.log('[HolePunch] Handling offer from', peerId);
    
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...this.config
    });
    
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(peerId, event.candidate);
      }
    };
    
    pc.onconnectionstatechange = () => {
      this.handleConnectionStateChange(peerId, pc.connectionState);
    };
    
    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerId, event.channel);
    };
    
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    this.sendSignalingMessage(peerId, {
      type: 'answer',
      sdp: answer
    });
    
    this.connections.set(peerId, pc);
  }
  
  /**
   * 處理傳入的 answer
   */
  async handleAnswer(peerId, sdp) {
    const pc = this.connections.get(peerId);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  }
  
  /**
   * 處理 ICE 候選者
   */
  async handleIceCandidate(peerId, candidate) {
    const pc = this.connections.get(peerId);
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('[HolePunch] Add ICE candidate error:', e);
      }
    }
  }
  
  /**
   * 發送 ICE 候選者（通過信令服務器）
   */
  onIceCandidate(peerId, candidate) {
    this.sendSignalingMessage(peerId, {
      type: 'ice-candidate',
      candidate: candidate
    });
  }
  
  /**
   * 發送信令消息（需要與 WS 集成）
   */
  sendSignalingMessage(peerId, message) {
    if (this.signalingCallback) {
      this.signalingCallback(peerId, message);
    } else {
      // 通過全局 ws 發送
      if (typeof ws !== 'undefined' && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'P2P_SIGNAL',
          target: peerId,
          signal: message,
          from: this.myPeerId
        }));
      }
    }
  }
  
  /**
   * 設置信令回調
   */
  setSignalingCallback(callback) {
    this.signalingCallback = callback;
  }
  
  /**
   * 處理連接狀態變化
   */
  handleConnectionStateChange(peerId, state) {
    console.log('[HolePunch] Connection state:', peerId, state);
    this.connectionStates.set(peerId, state);
    
    this.onConnectionStateChange?.(peerId, state);
    
    if (state === 'connected') {
      this.lastConnected.set(peerId, Date.now());
      console.log('[HolePunch] Connected to', peerId);
    } else if (state === 'failed' || state === 'disconnected') {
      console.log('[HolePunch] Connection failed, retrying...');
      this.retryConnection(peerId);
    }
  }
  
  /**
   * 重試連接
   */
  async retryConnection(peerId) {
    const pc = this.connections.get(peerId);
    if (pc) {
      pc.close();
      this.connections.delete(peerId);
      this.dataChannels.delete(peerId);
    }
    
    // 等待後重試
    setTimeout(() => {
      this.connect(peerId);
    }, 2000);
  }
  
  /**
   * 強制使用 TURN 中繼模式
   */
  async forceRelayMode(peerId) {
    const pc = this.connections.get(peerId);
    if (!pc) return;
    
    // 只保留 TURN 服務器
    pc.configuration.iceServers = this.iceServers.filter(s => 
      s.urls.startsWith('turn:')
    );
    
    // 重置 ICE
    pc.restartIce();
    console.log('[HolePunch] Force TURN relay mode for', peerId);
  }
  
  /**
   * 設置 DataChannel 處理
   */
  setupDataChannel(peerId, dc) {
    dc.onopen = () => {
      console.log('[HolePunch] DataChannel open:', peerId);
      this.onChannelOpen?.(peerId);
    };
    
    dc.onclose = () => {
      console.log('[HolePunch] DataChannel closed:', peerId);
      this.onChannelClose?.(peerId);
    };
    
    dc.onerror = (error) => {
      console.error('[HolePunch] DataChannel error:', peerId, error);
    };
    
    dc.onmessage = (event) => {
      this.onChannelMessage?.(peerId, event.data);
    };
    
    this.dataChannels.set(peerId, dc);
  }
  
  /**
   * 發送消息
   */
  send(peerId, data) {
    const dc = this.dataChannels.get(peerId);
    if (dc?.readyState === 'open') {
      dc.send(data);
      return true;
    }
    return false;
  }
  
  /**
   * 廣播消息
   */
  broadcast(data) {
    for (const [peerId, dc] of this.dataChannels) {
      if (dc.readyState === 'open') {
        try {
          dc.send(data);
        } catch (e) {
          console.error('[HolePunch] Broadcast error:', peerId, e);
        }
      }
    }
  }
  
  /**
   * 獲取連接的節點列表
   */
  getConnectedPeers() {
    const peers = [];
    for (const [peerId, dc] of this.dataChannels) {
      if (dc.readyState === 'open') {
        peers.push(peerId);
      }
    }
    return peers;
  }
  
  /**
   * 獲取連接狀態
   */
  getConnectionInfo(peerId) {
    const pc = this.connections.get(peerId);
    const state = this.connectionStates.get(peerId);
    
    if (!pc) return { state: 'disconnected' };
    
    // 獲取連接信息
    let connectionType = 'unknown';
    let relay = false;
    
    try {
      const receivers = pc.getReceivers();
      for (const receiver of receivers) {
        const params = receiver.transport?.iceTransport?.getSelectedCandidatePair();
        if (params) {
          if (params.local?.type === 'relayed') {
            relay = true;
            connectionType = 'relay (TURN)';
          } else if (params.local?.type === 'host') {
            connectionType = 'direct';
          } else if (params.local?.type === 'srflx') {
            connectionType = 'NAT';
          }
        }
      }
    } catch (e) {}
    
    return {
      state,
      connectionType,
      relay,
      lastConnected: this.lastConnected.get(peerId)
    };
  }
  
  /**
   * 斷開連接
   */
  disconnect(peerId) {
    const pc = this.connections.get(peerId);
    const dc = this.dataChannels.get(peerId);
    
    if (dc) {
      dc.close();
      this.dataChannels.delete(peerId);
    }
    if (pc) {
      pc.close();
      this.connections.delete(peerId);
    }
    
    this.connectionStates.delete(peerId);
    console.log('[HolePunch] Disconnected:', peerId);
  }
  
  /**
   * 斷開所有連接
   */
  disconnectAll() {
    for (const peerId of this.connections.keys()) {
      this.disconnect(peerId);
    }
  }
  
  /**
   * 獲取統計信息
   */
  getStats() {
    let connected = 0;
    let relay = 0;
    let direct = 0;
    
    for (const [peerId, dc] of this.dataChannels) {
      if (dc.readyState === 'open') {
        connected++;
        const info = this.getConnectionInfo(peerId);
        if (info.connectionType === 'relay (TURN)') relay++;
        else if (info.connectionType === 'direct') direct++;
      }
    }
    
    return {
      totalConnections: this.connections.size,
      connected,
      relay,
      direct,
      failed: this.connectionStates.size - connected
    };
  }
}

// 導出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HolePunchingGateway };
}
