# OurBackyard - 完整技術棧文檔

## 📋 項目概述

**OurBackyard** 是一個 P2P 社區應用，專為卡加利（Calgary）鄰里設計，實現去中心化的物品交易與即時通訊。

- **倉庫**: https://github.com/Liangwei-zhang/OurBackyard-PoC
- **Web**: https://reports-selections-numbers-authentication.trycloudflare.com
- **APK**: `android/app/build/outputs/apk/debug/app-debug.apk` (5.5MB)

---

## 🏗️ 架構圖

```
┌─────────────────────────────────────────────────────────────┐
│                      OurBackyard                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐      WebSocket       ┌──────────────┐   │
│  │   手機 A     │◄─────────────────────►│    服務器     │   │
│  │   (P2P)     │    (信令 + 廣播)      │  (FastAPI)   │   │
│  └──────┬───────┘                      └───────┬──────┘   │
│         │                                          │         │
│         │          P2P (WebRTC)                  │         │
│         ├────────────────────────────────────────┤         │
│         │                                         │         │
│         ├─ 圖片傳輸 (背壓控制)                    │         │
│         ├─ Merkle 增量同步 (Worker)             │         │
│         ├─ ICE Restart 自動重連                 │         │
│         └─ 15秒心跳                              │         │
│                │                                  │         │
│                └──────── OPFS + IndexedDB ──────┘         │
│                        (本地持久化)                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Capacitor 原生插件                       │  │
│  │  • Push Notifications (靜默推送)                    │  │
│  │  • Network (網絡檢測)                              │  │
│  │  • Geolocation (GPS)                              │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 技術棧詳解

### 1. 前端

| 技術 | 用途 | 版本 |
|------|------|------|
| **HTML5** | 單文件應用結構 | - |
| **Vanilla JS** | 無框架，減少依賴 | ES2022 |
| **CSS3** | OKLCH 色彩 + 毛玻璃效果 | - |
| **Dexie.js** | IndexedDB 封裝 | 4.0.1 |
| **h3-js** | H3 地理索引 | 4.0.0 |

### 2. 通信層

| 技術 | 用途 | 特性 |
|------|------|------|
| **WebSocket** | 信令服務、消息廣播 | 雙向實時 |
| **WebRTC** | P2P 數據傳輸 | RTCDataChannel |
| **ICE Restart** | 連接自動修復 | 斷線重連 |
| **Backpressure** | 大文件傳輸控制 | 緩衝區管理 |

### 3. 存儲層

| 技術 | 用途 | 容量 |
|------|------|------|
| **IndexedDB** | 物品元數據 | 建議 < 50MB |
| **OPFS** | 大文件存儲 (可選) | 無限制 |
| **localStorage** | mDNS 發現 | 5MB |

### 4. 後端

| 技術 | 用途 | 框架 |
|------|------|------|
| **Python** | 信令服務器 | FastAPI |
| **WebSocket** | 實時通信 | uvicorn |
| **Cloudflare Tunnel** | 公開訪問 | - |

### 5. 移動端

| 技術 | 用途 | 狀態 |
|------|------|------|
| **Capacitor** | 跨平台封裝 | ✅ |
| **Android** | APK 構建 | ✅ 5.5MB |
| **iOS** | Xcode 構建 | 待完成 |

---

## 🔧 核心模塊

### 1. 圖片傳輸協議

```
發送端                                    接收端
  │                                         │
  │─ {IMG_HEADER, itemId, size, mime} ────>│ 建立緩存
  │─ [binary chunk 16KB] ─────────────────>│ 緩存分片
  │─ [binary chunk 16KB] ─────────────────>│ .
  │─ ... ─────────────────────────────────>│ .
  │─ {IMG_END, itemId} ───────────────────>│ 組裝 → IndexedDB
```

**背壓控制邏輯**:
```javascript
while (ws.bufferedAmount > 1024 * 1024) {  // > 1MB 暫停
  await new Promise(r => setTimeout(r, 100));
}
```

### 2. DID 身份驗證

- **算法**: ECDSA P-256
- **密鑰存儲**: localStorage
- **消息簽名**: 所有廣播附加簽名

```javascript
// 生成密鑰對
const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true, ['sign', 'verify']
);

// 簽名消息
const signature = await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  privateKey,
  encoder.encode(JSON.stringify(message))
);
```

### 3. 自適應心跳

| 狀態 | 間隔 | 觸發 |
|------|------|------|
| 前台 | 15秒 | visibilitychange |
| 後台 | 60秒 | visibilitychange |

### 4. Merkle 增量同步

```javascript
// Worker 中計算哈希
MerkleSync.hashItem(item) {
  return simpleHash(JSON.stringify(item));
}

// 差異檢測
MerkleSync.findDifferences(localHashes, remoteHashes) {
  // 返回缺失的 item ID
}
```

### 5. mDNS 離線發現

- **機制**: localStorage 跨標籤頁廣播
- **觸發**: NetworkService 檢測到離線
- **範圍**: 同一設備多標籤頁 / 同一域名的 Service Worker

---

## 📁 項目結構

```
OurBackyard-PoC/
├── index.html              # 主應用 (單文件, ~200KB)
├── server.py               # FastAPI 信令服務器
├── SPEC.md                 # 技術規格
├── TODO.md                 # 待辦事項
├── package.json            # npm 配置
├── capacitor.config.json   # Capacitor 配置
│
├── www/
│   └── index.html          # 開發版本源碼
│
├── android/                # Android 項目
│   ├── app/
│   │   └── build.gradle
│   └── gradle/
│
├── ios/                    # iOS 項目
│   └── App/
│
├── native/
│   ├── NativeService.js    # 原生服務
│   └── mDNS.js            # mDNS 發現
│
├── capacitor/
│   └── SETUP.md           # Capacitor 安裝指南
│
├── push/
│   └── README.md          # 靜默推送配置
│
└── coturn/
    ├── docker-compose.yml  # TURN 服務器
    └── turnserver.conf    # TURN 配置
```

---

## 📊 性能指標

| 指標 | 數值 |
|------|------|
| 首屏載入 | < 500ms |
| 圖片懶加載 | 100ms 觸發 |
| 心跳延遲 | 15秒 |
| APK 大小 | 5.5MB |
| 內存佔用 | < 100MB (500物品) |

---

## 🔐 安全特性

1. **DID 簽名** - 防止偽造消息
2. **WSS 加密** - 傳輸層安全
3. **本地存儲** - 數據不離開設備
4. **P2P 直連** - 減少服務器依賴

---

## 🚀 部署

### 服務器
```bash
cd OurBackyard-PoC
python3 server.py
# 默認端口 8000
```

### Android APK
```bash
cd android
./gradlew assembleDebug
# 輸出: app/build/outputs/apk/debug/app-debug.apk
```

### Cloudflare Tunnel
```bash
cloudflared tunnel --url http://localhost:8000
```

---

## 📝 API 協議

### 消息類型

| 類型 | 方向 | 用途 |
|------|------|------|
| `NEW_ITEM` | 雙向 | 發布物品 |
| `ITEM_UPDATE` | 雙向 | 更新狀態 |
| `CHAT` | 雙向 | 即時訊息 |
| `HEARTBEAT` | 客戶端→服務器 | 在線檢測 |
| `IMG_HEADER` | 雙向 | 圖片元數據 |
| `IMG_END` | 雙向 | 圖片傳輸結束 |
| `SYNC_REQUEST` | 客戶端→服務器 | 請求同步 |
| `SYNC_RESPONSE` | 雙向 | 同步響應 |

---

## 🔜 未來規劃

- [ ] TURN 服務器部署 (Oracle Cloud ARM)
- [ ] Firebase 推送通知
- [ ] APNs iOS 推送
- [ ] 地圖視圖 (Leaflet)
- [ ] 評分系統
