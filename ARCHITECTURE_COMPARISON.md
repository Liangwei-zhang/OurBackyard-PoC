# OurBackyard - 架構對比與優化建議

## 📊 方案對比

| 特性 | 當前方案 (混合) | 純 P2P 商業方案 |
|------|-----------------|------------------|
| **信令** | FastAPI WebSocket | Libp2p + Waku DHT |
| **數據存儲** | IndexedDB + OPFS | OPFS + Yjs CRDT |
| **節點發現** | mDNS + BLE + WiFi | DHT + BLE Mesh |
| **冗餘備份** | Sponsor Node | 桌面全節點 |
| **身份** | Ed25519 + UCAN | Ed25519 DID + PoW |
| **AI 治理** | 本地向量搜索 | 本地 LLM |

---

## 🎯 優化建議：混合架構

### 方案選擇：保留當前優勢 + 增強 P2P

```
┌─────────────────────────────────────────────────────────────┐
│                    OurBackyard 混合架構                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                 通訊層 (增強)                          │  │
│  │  ┌─────────┐   ┌─────────┐   ┌─────────┐         │  │
│  │  │  服務器   │◄─►│  DHT    │◄─►│  BLE    │         │  │
│  │  │ (可選)   │   │        │   │  Mesh   │         │  │
│  │  └────┬────┘   └────┬────┘   └────┬────┘         │  │
│  │       │              │              │                │  │
│  │       └──────────────┴──────────────┘                │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                 數據層 (增強)                          │  │
│  │  ┌─────────┐   ┌─────────┐   ┌─────────┐         │  │
│  │  │ Yjs     │   │  Geo    │   │ Desktop │         │  │
│  │  │ CRDT    │◄─►│ Rep    │◄─►│ Node    │         │  │
│  │  └─────────┘   └─────────┘   └─────────┘         │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                 信任層 (增強)                          │  │
│  │  ┌─────────┐   ┌─────────┐   ┌─────────┐         │  │
│  │  │ Client  │   │   WoT  │   │ Desktop │         │  │
│  │  │ PoW     │   │ Trust  │◄─►│ LLM     │         │  │
│  │  └─────────┘   └─────────┘   └─────────┘         │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 📋 優先優化清單

### P0 - 核心改進

#### 1. 實現 Client-side PoW 防垃圾
```javascript
// native/pow-spam-protection.js

const PoWSpamProtection = {
  difficulty: 1000,  // 難度係數
  maxDelay: 2000,   // 最大延遲 (ms)
  
  // 計算 PoW
  async compute(target) {
    const start = Date.now();
    let nonce = 0;
    
    while (true) {
      const hash = await this.hash(target + nonce);
      if (this.isValid(hash)) {
        return { nonce, hash, time: Date.now() - start };
      }
      nonce++;
      
      // 防止過熱
      if (Date.now() - start > this.maxDelay) {
        throw new Error('PoW timeout');
      }
    }
  },
  
  // 驗證 PoW
  async verify(target, nonce) {
    const hash = await this.hash(target + nonce);
    return this.isValid(hash);
  },
  
  hash(str) {
    // 簡單 hash (實際使用 SHA-256)
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    }
    return h;
  },
  
  isValid(hash) {
    return hash % this.difficulty === 0;
  }
};
```

#### 2. 實現 WoT 信任網
```javascript
// native/wot-trust.js

const WebOfTrust = {
  trustedPeers: new Map(),  // peerId -> trust level
  
  // 信任鄰居
  async trust(peerId, level) {
    this.trustedPeers.set(peerId, level);
  },
  
  // 計算消息權重
  calculateWeight(fromPeerId, baseWeight = 1) {
    // 直接信任
    let weight = baseWeight;
    
    // 根據信任級別調整
    const trust = this.trustedPeers.get(fromPeerId);
    if (trust) {
      weight *= (1 + trust * 0.5);
    }
    
    return weight;
  },
  
  // 過濾低權重消息
  shouldDisplay(fromPeerId, content) {
    const weight = this.calculateWeight(fromPeerId);
    return weight >= 0.5;
  }
};
```

#### 3. 實現 Desktop Full Node 支持
```javascript
// native/desktop-node.js

const DesktopFullNode = {
  isDesktop: false,
  isFullNode: false,
  
  // 檢測是否為桌面節點
  async checkCapabilities() {
    // 檢查設備能力
    const memory = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    
    this.isDesktop = memory >= 8 && cores >= 4;
    this.isFullNode = this.isDesktop;
    
    return {
      isDesktop: this.isDesktop,
      isFullNode: this.isFullNode,
      capabilities: {
        memory,
        cores,
        storage: await navigator.storage?.estimate?.() || {}
      }
    };
  },
  
  // 作為全節點運行
  async runAsFullNode(peerId, h3Index) {
    if (!this.isFullNode) {
      console.log('[Desktop] Not capable of running as full node');
      return false;
    }
    
    // 啟用服務
    await this.enableDataProxy();     // 數據代理
    await this.enableLLMFilter();    // AI 過濾
    await this.enable24hSync();      // 24小時同步
    
    console.log('[Desktop] Running as full node for H3:', h3Index);
    return true;
  }
};
```

---

### P1 - 高級功能

#### 4. Waku 消息協議兼容
```javascript
// native/waku-compat.js

const WakuCompat = {
  // Waku 風格的 Topic 訂閱
  async subscribe(topic) {
    // 使用 GossipSub 訂閱
    await Libp2pService.subscribeToTopic(topic);
  },
  
  // 輕節點模式 (手機)
  async asLightNode() {
    // 只訂閱自己 H3 區域的消息
    const topic = `ourbackyard.h3.${currentH3Index}`;
    await this.subscribe(topic);
  },
  
  // 轉發節點 (桌面)
  async asRelayNode() {
    // 訂閱多個相關 topic
    const topics = [
      `ourbackyard.h3.${currentH3Index}`,
      `ourbackyard.h3.ring1.${currentH3Index}`,
      `ourbackyard.emergency`
    ];
    
    for (const topic of topics) {
      await this.subscribe(topic);
    }
  }
};
```

#### 5. 本地 LLM 內容過濾
```javascript
// native/local-llm-filter.js

const LocalLLMFilter = {
  enabled: false,
  model: null,
  
  // 初始化 (僅桌面節點)
  async init() {
    // 檢查能力
    const { isFullNode } = await DesktopFullNode.checkCapabilities();
    if (!isFullNode) return;
    
    // 加載輕量模型 (模擬)
    this.model = {
      name: 'local-filter',
      ready: true
    };
    
    this.enabled = true;
    console.log('[LLM] Local filter enabled');
  },
  
  // 分析內容
  async analyze(content) {
    if (!this.enabled) return { allowed: true, reason: 'no-filter' };
    
    // 簡單關鍵詞過濾 (實際使用本地 LLM)
    const spam = ['buy now', 'click here', 'free money'];
    const lower = content.toLowerCase();
    
    for (const word of spam) {
      if (lower.includes(word)) {
        return { allowed: false, reason: 'spam-detected', score: 0.9 };
      }
    }
    
    return { allowed: true, reason: 'clean', score: 0.1 };
  }
};
```

---

## 📊 實施計劃

| 優先級 | 任務 | 預計時間 |
|--------|------|----------|
| P0 | Client-side PoW | 1天 |
| P0 | WoT 信任網 | 2天 |
| P0 | Desktop Node 檢測 | 1天 |
| P1 | Waku 兼容性 | 3天 |
| P1 | 本地 LLM 過濾 | 5天 |
| P2 | 完整桌面節點 | 7天 |

---

## ✅ 結論

**推薦混合架構**：
- 保留可選的服務器 (降級使用)
- 增強純 P2P 能力 (DHT + BLE Mesh)
- 加入 PoW + WoT 防垃圾
- 桌面節點自願運行

這樣既保持簡單，又具備商業級抗審查能力。
