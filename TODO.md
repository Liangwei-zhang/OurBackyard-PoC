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

## 🟢 低優先級

### E. 電量優化
- [ ] 檢測電量低時減少同步

### F. 地圖視圖
- [ ] Leaflet 集成
- [ ] 物品位置標記

---

## ✅ 已完成

1. ✅ mDNS 離線發現
2. ✅ Adaptive Heartbeat
3. ✅ DID 身份驗證
