# OurBackyard TODO - 代辦事項

## ✅ 已完成

### 安全
- [x] XSS 防護 (escapeHtml)
- [x] 圖片類型校驗 (file.type)
- [x] 消息去重 ID 優化
- [x] DID 簽名驗證增強 (所有字段)
- [x] CSP Content-Security-Policy 頭
- [x] 私鑰存儲安全註釋

### 數據庫
- [x] v5 升級遷移
- [x] 統一 blob 寫入 (saveBlobWithQuotaCheck)

### 網絡
- [x] WebSocket 自動重連 (指數退避)
- [x] 離線發布同步 (Service Worker)
- [x] 圖片下載超時釋放
- [x] IMG_CHUNK 錯誤處理釋放計數
- [x] 詳情頁主動請求缺失圖片
- [x] ws.onopen 隊列處理

### 性能
- [x] loadItems 增量渲染
- [x] 防抖應用 (debouncedLoadItems)
- [x] LazyLoader 觀察者優化

### 開發體驗
- [x] Eruda 手機調試工具
- [x] 全局錯誤處理器

### 架構 (模塊化)
- [x] 創建模塊化結構
- [x] js/db.js - 數據庫模塊
- [x] js/utils.js - 工具函數
- [x] src/crypto.js - DID 加密
- [x] src/network.js - WebSocket
- [x] src/p2p.js - P2P 數據通道
- [x] src/ui.js - UI 渲染
- [x] src/app.js - 主入口
- [x] package.json - npm 配置
- [x] 建立 src/ 原型模塊化結構

---

## 📋 待處理

### 架構
- [ ] 完成模塊化重構（當前生產入口仍為 index.html）

### 安全
- [ ] 私鑰加密存儲
- [ ] 地理位置隱私告知

### 用戶體驗
- [ ] 統一 UI 語言
- [ ] 編輯商品圖片功能

---

## 項目結構

```
OurBackyard-PoC/
├── index.html          # 當前穩定版本 (單文件)
├── native/             # 當前生產使用的模塊
├── js/
│   ├── db.js           # 數據庫模塊
│   ├── utils.js        # 工具函數
│   ├── dexie.js        # IndexedDB 庫
│   └── h3-js.js        # H3 庫
├── src/
│   ├── app.js          # 主入口
│   ├── crypto.js       # DID 加密
│   ├── network.js      # WebSocket
│   ├── p2p.js          # P2P 數據通道
│   └── ui.js           # UI 渲染
├── package.json        # npm 配置
└── src/                # 模塊化重構原型
```

---

## 評估

| 維度 | 評分 |
|------|------|
| 穩定性 | ⭐⭐⭐⭐⭐ |
| 安全 | ⭐⭐⭐⭐ |
| 性能 | ⭐⭐⭐⭐ |
| 可維護性 | ⭐⭐⭐⭐ |

**狀態：核心可用，仍需商業級 QA 收斂**
