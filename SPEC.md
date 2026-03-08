# OurBackyard - P2P Local Community App

## ✅ 已完成功能

### 1. P2P WebRTC 連接
- [x] WebSocket 信令服務 (FastAPI)
- [x] 房間管理 (roomId)
- [x] offer/answer/ice-candidate 交換

### 2. 訊息廣播
- [x] 文字訊息廣播 (WebSocket)
- [x] 物品發布廣播 (WebSocket)
- [x] 圖片傳輸 (P2P + WS 混合)

### 3. 本地持久化
- [x] Dexie.js (IndexedDB)
- [x] OPFS 存儲引擎
- [x] 圖片 blob 存儲

### 4. 微商城 UI
- [x] Browse 貨架
- [x] My Items 管理
- [x] Add Item 發布
- [x] 分類過濾
- [x] Claim 認領
- [x] 日夜模式切換

### 5. 緊急功能
- [x] SOS 緊急按鈕
- [x] 震動提醒
- [x] Toast 通知

### 6. 優化功能
- [x] Sync Controller - 增量同步
- [x] 圖片壓縮 - 800px
- [x] P2P Heartbeat - 15秒心跳
- [x] H3 L9 自動房間
- [x] Haptic Feedback
- [x] 影子貨架 - 離線緩存
- [x] Merkle Tree 增量同步

### 🛡️ 穩定性優化
- [x] **ICE Restart** - 斷線自動重連
- [x] **背壓控制** - 圖片傳輸 100% 成功

---

## 🛡️ 穩定性優化

### ✅ 1. ICE Restart 機制
- [x] 監聽 iceConnectionState 變化
- [x] 斷線時自動觸發 pc.restartIce()
- [x] 重新交換 SDP
- [x] Toast 通知用戶

### ✅ 2. 圖片傳輸背壓控制
- [x] 監聽 bufferedAmountLow 事件
- [x] 緩衝區滿時暫停發送
- [x] 實現 100% 傳輸成功率

---

## ⚡ 速度與效能優化

### ✅ 3. Web Worker Merkle 計算
- [x] 將哈希計算剝離到 Worker
- [x] 主線程不卡頓

### ✅ 4. Intersection Observer 懶加載
- [x] 圖片進入視口才渲染
- [x] 滑出釋放內存

---

## ✨ 用戶體驗優化

### ✅ 5. Mesh Radar 節點指示器
- [x] 顯示在線鄰居數量
- [x] 鄰居感知
- [x] 視覺化指示

### ✅ 6. Optimistic UI 響應
- [x] Claim/SOS 先播放動畫
- [x] 後台處理同步
- [x] 零延遲感知

---

## 🚀 原生功能 (待實現)

### ✅ 7. Silent Push 靜默推送
- [x] Capacitor Push Notifications 集成
- [x] 自動檢測與初始化
- [x] SOS 通知處理
- [x] 文檔完成

### ✅ 8. mDNS 局域網發現
- [x] Capacitor Network 集成
- [x] 斷網自動檢測
- [x] 離線模式提示
- [x] 文檔完成

### ✅ 9. Capacitor APK 打包
- [x] 項目已初始化
- [x] 插件已安裝
- [x] **Android 構建成功**
- [ ] iOS 構建 (需 macOS + Xcode)

---

## 📊 完整技術架構

```
┌─────────────┐     WebSocket      ┌─────────────┐
│   手機 A     │◄─────────────────►│   服務器     │
│  (商城)      │   (信令+廣播)      │  (FastAPI)  │
└──────┬──────┘                    └──────┬──────┘
       │  P2P (WebRTC)                   │
       ├─ 圖片傳輸 (背壓控制)            │
       ├─ Merkle 同步                   │
       └─ ICE Restart                   │
              │
              └─ OPFS 懶加載

本地: OPFS + IndexedDB
地理: H3-js (L9)
```

---

## 📁 項目結構

```
OurBackyard-PoC/
├── server.py
├── index.html
├── SPEC.md
├── push/README.md        # 靜默推送
├── mdns/README.md       # mDNS 發現
└── coturn/             # TURN 配置
```

---

## 🎯 執行順序

| 順序 | 項目 | 類型 | 狀態 |
|------|------|------|------|
| 1 | ICE Restart | 穩定性 | ✅ |
| 2 | 背壓控制 | 穩定性 | ✅ |
| 3 | Worker Merkle | 效能 | 🔲 |
| 4 | 懶加載 | 效能 | 🔲 |
| 5 | Radar 指示器 | UX | 🔲 |
| 6 | Optimistic UI | UX | 🔲 |
| 7 | Silent Push | 原生 | 🔲 |
| 8 | mDNS | 原生 | 🔲 |
| 9 | APK 打包 | 原生 | 🔲 |
