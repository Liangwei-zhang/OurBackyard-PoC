# OurBackyard PoC - 完整運行指南

## 架構

```
┌─────────────┐     WebSocket      ┌─────────────┐
│   Client A  │◄─────────────────► │  Signaling  │
│  (Offer)    │     (Relay)        │   Server    │
└─────────────┘                    └──────┬──────┘
       │                                     │
       │        WebRTC DataChannel          │
       └─────────────────────────────────────┘
                  (P2P Direct)
```

## 快速啟動

### 1. 安裝依賴

```bash
cd OurBackyard-PoC
pip install fastapi uvicorn websockets
```

### 2. 啟動服務器

```bash
uvicorn server:app --reload --port 8000
```

### 3. 測試

1. 打開瀏覽器訪問 `http://localhost:8000`
2. 打開第二個標籤頁（或用手機訪問同一網絡的 IP）
3. 點擊 **Join Network** 連接
4. 其中一方點擊 **Create Room** 發起連接
5. 另一方會收到 P2P 連接
6. 開始發消息測試

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

## H3 測試坐標

| 位置 | 經緯度 | H3 L9 |
|------|--------|-------|
| Calgary Downtown | 51.0447, -114.0719 | 8fb29a |
| Calgary NW (Edgemont) | 51.1285, -114.2103 | 8fb2c8 |
| Calgary NW (Dalhouise) | 51.1138, -114.1946 | 8fb2b1 |

## 下一步

- [ ] 添加 TURN 服務器配置
- [ ] 實現離線 NFC Bootstrap
- [ ] 添加 GunDB 數據持久化
- [ ] Capacitor 包裝 (iOS/Android)

## 文件結構

```
OurBackyard-PoC/
├── server.py      # WebSocket 信令服務器
├── index.html    # P2P 客戶端 (H3 + WebRTC)
└── README.md     # 本文件
```
