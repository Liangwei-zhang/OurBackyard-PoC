# 项目状态 — 2026-03-26

## ⚠️ 工作规则（每次操作前必读）

- **分支策略：所有修改直接在 master 上操作，不创建分支**

## 已完成
- ✅ `@ourbackyard/p2p-sdk` 6层架构已合入 master（PR #1, #7, #8）
- ✅ 325 单元测试通过（`node --test sdk/tests/*.test.js`）
- ✅ 废弃分支已全部清理，仅保留 master
- ✅ server.py SDK 信令协议 + CHAT bug 修复

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
- [x] 集成测试（22 项端到端测试，`sdk/tests/integration.test.js`）
- [x] 用 SDK 重构 index.html — P2P 层（`src/p2p-adapter.js` → `js/ob-sdk.js` IIFE 包，替换 native/communication/* 脚本）
- [x] IndexedDB 持久化存储实现（`sdk/src/storage/indexeddb-storage.js`，21 单元测试，p2p-adapter.js 已接入）
- [ ] TypeScript 类型声明
