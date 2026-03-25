# Copilot 工作指令

## ⚠️ 分支策略
**所有修改直接在 `master` 上操作，不创建分支，不创建 PR。**

## 📦 项目概况
- **仓库**: `Liangwei-zhang/OurBackyard-PoC`
- **产品**: OurBackyard — 面向 Calgary 的 P2P 去中心化社区应用
- **SDK**: `@ourbackyard/p2p-sdk`（`sdk/` 目录），零外部依赖，纯 ES Modules
- **测试**: 282 单元测试，运行方式 `node --test sdk/tests/*.test.js`
- **主分支**: `master`（唯一分支）

## 🏗 SDK 架构（6 层）
```
sdk/src/
├── Layer 0: Foundation      → event-bus.js, logger.js, config.js, utils.js
├── Layer 1: Identity/Crypto → identity.js, crypto/{key-vault, e2e-crypto, signature}
├── Layer 2: Transport       → transport/{transport-interface, webrtc-transport, websocket-transport}
├── Layer 3: Signaling       → signaling/{signaling-interface, nostr, websocket, multi, lan}
├── Layer 4: Sync/Routing    → sync/{message-router, plumtree-gossip, merkle-sync, crdt, gossip-sync, blob-transfer}
│                              storage/{storage-interface, memory-storage}
├── Layer 5: Resilience      → resilience/{reconnect-manager, health-monitor, circuit-breaker, rate-limiter}
├── Mesh                     → mesh/{cell-shard, resilience}
├── Orchestrator             → p2p-node.js
└── Protocols                → protocols/{marketplace, chat, file-share}
```

## ✅ 已完成
- SDK 6 层架构全部合入 master（PR #1, #7, #8）
- 282 单元测试通过
- WebRTC 背压修复 + server.py SDK 协议支持
- 废弃分支全部清理

## 📋 待办
- [ ] 添加 CI/CD（GitHub Actions 自动跑测试）
- [ ] 集成测试（端到端）
- [ ] 用 SDK 重构 index.html（379KB 单体文件）
- [ ] IndexedDB 持久化存储实现（替代 MemoryStorage）
- [ ] TypeScript 类型声明（.d.ts）
- [ ] npm 发布 @ourbackyard/p2p-sdk

## 🔑 关键技术点
- **MessageRouter**: Set O(1) dedup, 50K 容量 + LRU eviction
- **PlumtreeGossip**: Hybrid push/lazy-push, 40-60% 带宽节省
- **MerkleSync**: SHA-256 Merkle tree 增量同步
- **CRDT**: LWWRegister, ORSet, GCounter
- **WebRTC**: Glare resolution (polite/impolite), ICE restart, backpressure
- **MultiSignaling**: Nostr → WebSocket → LAN 优先级故障转移
- **CircuitBreaker**: CLOSED → OPEN → HALF_OPEN 状态机

## 📅 最后更新: 2026-03-25