# OurBackyard - 商業級優化開發清單

## 📋 概述

本清單涵蓋將 OurBackyard 從 PoC 升級為商業級完全分布式 P2P 應用的所有開發任務。

---

## 🔴 Phase 1: 數據持久化 (Data Persistence) ✅ 完成

### 1.1 Sponsor Node 分布式存儲 ✅
- [x] Hyperdrive 集成 (模塊化實現)
- [x] 鄰里備份邏輯
- [x] 實現備份數據恢復
- [x] 實現冗餘度控制 (默認 3 份)

### 1.2 CRDT 實時協作 ✅
- [x] Yjs 集成
- [x] 實現 CRDT 文檔結構
- [x] 實現衝突解決邏輯
- [x] 實現本地優先寫入
- [x] IndexedDB 持久化

**已完成模塊:**
- `native/p2p-store.js` - 統一 API
- `native/crdt-store.js` - CRDT 實現

---

## 🟠 Phase 2: 節點發現 (Node Discovery) 🔄

### 2.1 DHT 全球發現
- [ ] Hyperswarm 集成
- [ ] 實現 Topic 訂閱
- [ ] 實現自動打洞

### 2.2 mDNS 局域網發現 ✅
- [x] 實現服務公告
- [x] 實現服務發現

### 2.3 BLE 藍牙發現 🔄
- [x] Web Bluetooth 框架
- [ ] 實現後台 BLE

---

## 🟡 Phase 3: 信任與聲譽 (Trust & Reputation) ✅ 完成

### 3.1 UCAN 權限系統 ✅
- [x] 實現能力創建
- [x] 實現能力委託
- [x] 實現能力驗證

### 3.2 ZK 聲譽系統 ✅ 完成
- [x] **Pedersen Commitment** - 零知識承諾
- [x] **Schnorr Protocol** - 知識證明
- [x] **Threshold Proof** - 閾值證明 (證明聲譽 >= X)
- [x] 實現匿名憑證頒發
- [x] 實現行為報告

### 3.3 Sybil 防護
- [x] 實現聲譽門檻
- [x] 實現 rate limiting

**已完成模塊:**
- `native/zk-reputation-complete.js` - 完整 ZK 系統

---

## 🟢 Phase 4: 邊緣 AI (Edge AI) ✅ 完成

### 4.1 本地語義搜索 ✅ 完成
- [x] 實現文本向量化
- [x] **Enhanced Hash Embedding** - 多哈希特徵
- [x] **N-gram Features** - 雙詞組合特徵
- [x] 實現向量存儲
- [x] 實現相似度計算

### 4.2 智能推薦 ✅
- [x] 實現時間上下文
- [x] 實現類別推薦
- [x] 實現智能建議

**已完成模塊:**
- `native/local-ai-complete.js` - 完整 AI 系統

---

## 🔵 Phase 5: 性能優化 (Performance)

### 5.1 Web Worker
- [ ] 實現 Libp2p Worker
- [ ] 實現消息隊列

### 5.2 網絡優化
- [ ] 實現消息壓縮
- [ ] 實現增量傳輸

---

## 🟣 Phase 6: 安全與隱私 (Security & Privacy)

### 6.1 端到端加密
- [ ] 實現 X25519 密鑰交換
- [ ] 實現前向保密

### 6.2 隱私保護
- [ ] 實現本地加密存儲
- [ ] 實現選擇性披露

---

## ⚫ Phase 7: 災難恢復 (Disaster Recovery)

### 7.1 離網通訊
- [ ] 實現消息跳躍
- [ ] 實現路由發現

### 7.2 應急模式
- [x] 實現 SOS 功能
- [ ] 實現緊急訊息優先級

---

## 📊 開發優先級

| 優先級 | 任務 | 狀態 |
|--------|------|------|
| **P0** | Sponsor Node + CRDT | ✅ 完成 |
| **P1** | ZK 聲譽系統 | ✅ 完成 |
| **P1** | Local搜索 | ✅ 完成 |
| P2 | Hyperswarm D AI 語義HT | 🔄 |
| P2 | BLE + Wi-Fi Direct | 🔄 |
| P3 | 完整 DTN | 🔲 |

---

## 📦 當前依賴

```json
{
  "dependencies": {
    "libp2p": "^1.0.0",
    "yjs": "^13.6.0",
    "y-indexeddb": "^9.0.0",
    "y-websocket": "^2.0.0",
    "dexie": "^4.0.1",
    "h3-js": "^4.0.0"
  }
}
```

---

## ✅ 當前狀態: Phase 1-4 完成

- [x] mDNS 離線發現
- [x] Adaptive Heartbeat
- [x] DID 身份驗證
- [x] 二進制圖片傳輸
- [x] Libp2p 模塊
- [x] UCAN 身份模塊
- [x] Hypercore 存儲模塊
- [x] **P2P Store (Sponsor + CRDT)** - 新 ✅
- [x] **ZK Reputation System** - 新 ✅
- [x] **Local AI System** - 新 ✅
- [ ] Hyperswarm DHT
- [ ] BLE + Wi-Fi Direct
- [ ] Web Worker
- [ ] E2E 加密
- [ ] DTN
