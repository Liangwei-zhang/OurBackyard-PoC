# OurBackyard PoC - 運行指南

## 架構

```
┌─────────────┐    Nostr / LAN     ┌─────────────┐
│   Client A  │◄─────────────────► │   Client B  │
│   (PWA)     │    discovery       │   (PWA)     │
└──────┬──────┘                    └──────┬──────┘
       │                                     │
       │        WebRTC DataChannel           │
       └─────────────────────────────────────┘
                   (P2P Direct)
```

## 快速啟動

### 1. 啟動 PWA（推薦）

```bash
cd OurBackyard-PoC
./start-server.sh
```

或：

```bash
python3 -m http.server 8080
```

然後打開 `http://localhost:8080`

### 2. 可選：啟動舊版 FastAPI 輔助服務

只有在你需要測試舊的 WebSocket / upload API 時才需要：

```bash
pip install fastapi uvicorn websockets
uvicorn server:app --reload --port 8080
```

### 3. 測試

1. 打開瀏覽器訪問 `http://localhost:8080`
2. 打開第二個標籤頁（或用手機訪問同一網絡的 IP）
3. 允許位置權限，等待 P2P mesh 初始化
4. 在一端發布商品
5. 在另一端確認商品同步、聊天與圖片傳輸

## 部署到雲端

### Railway (免費)

```bash
# 安裝 railway CLI
npm i -g @railway/cli
railway login
railway init
railway up
```

### Render / Replit

直接上傳代碼，設置啟動命令：
```
uvicorn server:app --host 0.0.0.0 --port $PORT
```

## 自動 ICE/TURN 配置

客戶端啟動時會自動拉取以下路徑（按順序）：

1. `/ice-servers.json`
2. `/.well-known/ourbackyard/ice-servers.json`

並緩存到 `localStorage`（12 小時），用戶不需要手動在控制台設置 IP。

默認配置文件：

- `ice-servers.json`
- `public/ice-servers.json`

其中 `turn:{hostname}:3478` 會自動替換為當前站點域名。

## H3 測試坐標

| 位置 | 經緯度 | H3 L9 |
|------|--------|-------|
| Calgary Downtown | 51.0447, -114.0719 | 8fb29a |
| Calgary NW (Edgemont) | 51.1285, -114.2103 | 8fb2c8 |
| Calgary NW (Dalhouise) | 51.1138, -114.1946 | 8fb2b1 |

## 下一步

- [x] 添加 TURN 服務器配置
- [ ] 實現離線 NFC Bootstrap
- [ ] 添加 GunDB 數據持久化
- [ ] Capacitor 包裝 (iOS/Android)

## 文件結構

```
OurBackyard-PoC/
├── index.html     # 當前主入口（單文件 PWA）
├── native/        # P2P / 安全 / UI 原生模塊
├── server.py      # 舊版 FastAPI 輔助服務
└── README.md      # 本文件
```
