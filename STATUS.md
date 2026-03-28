# 项目状态 — 2026-03-27

## ⚠️ 工作规则（每次操作前必读）

- **分支策略：所有修改直接在 master 上操作，不创建分支**

## 已完成
- ✅ `@ourbackyard/p2p-sdk` 6层架构已合入 master（PR #1, #7, #8）
- ✅ 536 单元测试通过（`node --test sdk/tests/*.test.js`）
- ✅ 废弃分支已全部清理，仅保留 master
- ✅ server.py SDK 信令协议 + CHAT bug 修复
- ✅ **修复 setSendFn 竞态条件**（商品同步根本原因）：`p2p-node.start()` 中 `setSendFn` 移至所有 `await` 之前，`peer:connected` 触发时 sendFn 必定已就绪，SYNC_REQ 不再静默丢失
- ✅ 添加 `[SDK]` 控制台诊断日志（MerkleSync、GossipSync、adapter `item:received` 全链路可追踪）
- ✅ SW v48，bundle 重建 63.83 kB

## 架构
```
sdk/src/
├── Layer 0: event-bus, logger, config, utils
├── Layer 1: identity, crypto/{key-vault, e2e-crypto, signature}
├── Layer 2: transport/{webrtc, websocket}
├── Layer 3: signaling/{nostr, websocket, multi, lan}
├── Layer 4: sync/{message-router, plumtree-gossip, merkle-sync, crdt, gossip-sync, blob-transfer}
├── Layer 5: resilience/{reconnect, health-monitor, circuit-breaker, rate-limiter}
├── Mesh: mesh/{cell-shard, resilience}
├── Orchestrator: p2p-node.js
└── Protocols: protocols/{marketplace, chat, file-share}
```

## 待办
- [x] 添加 CI/CD（GitHub Actions `.github/workflows/ci.yml`）
- [x] 集成测试（32 项端到端测试，`sdk/tests/integration.test.js`）
- [x] 用 SDK 重构 index.html — P2P 层（`src/p2p-adapter.js` → `js/ob-sdk.js` IIFE 包，替换 native/communication/* 脚本）
- [x] IndexedDB 持久化存储实现（`sdk/src/storage/indexeddb-storage.js`，21 单元测试，p2p-adapter.js 已接入）
- [x] TypeScript 类型声明（36 个 `.d.ts` 模块 + `sdk/index.d.ts` barrel，`package.json` 已添加 `types` 字段）
- [x] npm 发布（`@ourbackyard/p2p-sdk@0.1.0` 已上线 https://www.npmjs.com/package/@ourbackyard/p2p-sdk）
- [x] 清理废弃文件（删除 153 个文件 / 24k 行：src/ 失败模块化、native/communication|data|ai|governance|security 实验代码、android/ios/capacitor 移动端）
- [x] native/ 目錄整理完成 — 所有活躍模組移至 app/ 子目錄，native/ 已刪除
- [x] **修复商品同步**：消除 setSendFn 竞态条件，所有 P2P 消息（SYNC_REQ / GOSSIP_MSG）在 peer:connected 触发前必定可达
- [ ] 端到端集成测试（真实 WebRTC + Nostr 环境）
- [ ] 将 index.html 379KB 单体拆分为模块化结构
