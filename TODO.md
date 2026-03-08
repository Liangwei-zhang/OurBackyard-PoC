# OurBackyard - 待完成優化

## 🔴 高優先級

### A. mDNS 離線發現 ✅ 已完成
- [x] 斷網自動檢測
- [x] 區域網鄰居發現
- [x] localStorage 廣播機制

### B. Adaptive Heartbeat (自適應心跳) ✅ 已完成
- [x] 檢測 App 進入 background
- [x] 後台時延長心跳至 60 秒
- [x] 前台時保持 15 秒心跳

## 🟡 中優先級

### C. DID (去中心化身份) ✅ 已完成
- [x] 生成公私鑰 (Web Crypto API)
- [x] 消息簽名驗證
- [x] 廣播時自動附加簽名

### D. 二進制優先策略 (Binary-First) ✅ 已完成
- [x] 分析當前方案問題
- [x] 實現雙縮略圖策略 (Micro-Thumb 50px + Full-Thumb 800px)
- [x] 實現 Blob + 懟加載 + revokeObjectURL
- [x] 分離存儲 (元數據 vs 圖片)

## 🟢 完全分布式 P2P 架構 (進行中)

### E. Libp2p 集成 🔄
- [x] Libp2p 服務模塊 (native/libp2p.js)
- [ ] 配置 bootstrap 節點
- [ ] 實現 DHT 發現
- [ ] 集成到主應用

### F. UCAN 身份驗證 🔄
- [x] UCAN 服務模塊 (native/ucan.js)
- [ ] 離線授權鏈
- [ ] 能力委託

### G. Hypercore 存儲 🔄
- [x] Hypercore 存儲模塊 (native/hypercore.js)
- [ ] Append-only 日誌
- [ ] Merkle 樹驗證
- [ ] 增量同步

### H. GossipSub 協議
- [ ] H3-Topic 訂閱
- [ ] 地理路由優化

---

## ✅ 已完成

1. ✅ mDNS 離線發現
2. ✅ Adaptive Heartbeat
3. ✅ DID 身份驗證
4. ✅ 二進制圖片傳輸
5. ✅ Libp2p 模塊
6. ✅ UCAN 身份模塊
7. ✅ Hypercore 存儲模塊
