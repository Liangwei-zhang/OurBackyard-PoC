# PS2 Framework (Decentralized Core)

`PS2` is a reusable peer-to-peer application core with two built-in domains:

1. `IM` (text + multimedia metadata, reliable ACK/retry)
2. `Market` (publish/update/delete with operation-log sync)

## Architecture

- `PS2Kernel`: runtime orchestrator
- `ReliableMailbox`: direct-message reliability layer (`ACK + retry + dedupe`)
- `IMModule`: conversation domain
- `MarketModule`: item CRUD domain (op-log based)
- `DexiePS2Store`: optional durable storage adapter for IndexedDB/Dexie
- `MeshTransportAdapter`: adapter to `OurBackyardMesh`

## Quick Start

```js
import { PS2Kernel, MeshTransportAdapter, DexiePS2Store } from "./src/ps2/index.js";

const adapter = new MeshTransportAdapter(window.mesh);
const store = new DexiePS2Store({ db: window.db });
await store.ready;
const kernel = new PS2Kernel({
  nodeId: window.peerId,
  transport: adapter,
  store,
  autoSyncMs: 15000, // optional anti-entropy pull every 15s
});

kernel.start();

await kernel.im.sendText("peer_x", "hello");
const itemId = kernel.market.publishItem({ title: "Bike", price: 100 });
kernel.market.updateItem(itemId, { price: 90 });
kernel.market.deleteItem(itemId);
```

## Reconnect Sync (Anti-Entropy)

`MarketModule` and `IMModule` support explicit sync recovery:

```js
await kernel.market.requestSync("peer_x");
await kernel.im.requestSync("peer_x", { limit: 300 });
```

When `autoSyncMs` is enabled and `transport.listPeers()` is available,
the kernel periodically asks connected peers for market snapshots and
chat history deltas.

## Integration Hook (Mesh)

In mesh data routing:

```js
if (msg.type === "PS2_FRAME") {
  await adapter.consumeMeshMessage(msg);
  return;
}
```
