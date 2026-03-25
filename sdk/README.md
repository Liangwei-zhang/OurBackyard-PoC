# @ourbackyard/p2p-sdk

Modular, framework-agnostic P2P SDK — WebRTC mesh networking with pluggable signaling.

## Quick Start (10 lines)

```js
import { P2PNode, NostrSignaling, MemoryStorage } from '@ourbackyard/p2p-sdk';

const node = new P2PNode({
  peerId:    'alice-abc123',
  signaling: new NostrSignaling({ peerId: 'alice-abc123', h3Cell: '8928308280fffff' }),
  storage:   new MemoryStorage(),
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
});

await node.start();
node.on('peer:connected', peer => console.log('Connected:', peer));
node.on('message',        msg  => console.log('Msg from', msg.from, ':', msg));
node.broadcast('HELLO', { text: 'World' });
```

---

## Architecture

```
┌────────────────────────────────────────────────┐
│                  P2PNode                       │  ← orchestrator / event facade
│  (event-bus + wires all modules together)      │
└──────────┬──────────────────────┬──────────────┘
           │                      │
    ┌──────▼──────┐        ┌──────▼──────────────┐
    │  Signaling  │        │  WebRTCTransport     │
    │  (ISignaling│        │  (RTCPeerConnection  │
    │   interface)│        │   + DataChannel)     │
    │             │        └──────────┬───────────┘
    │ NostrSignal │                   │
    │  - or -     │           ┌───────▼──────────┐
    │ WSSignaling │           │  MessageRouter    │
    └─────────────┘           │  (type dispatch   │
                              │   + dedup)        │
                              └─────┬───────┬─────┘
                                    │       │
                          ┌─────────▼─┐ ┌───▼──────────┐
                          │ GossipSync│ │ BlobTransfer  │
                          │ (item      │ │ (binary blob  │
                          │  broadcast │ │  streaming)   │
                          │  + sync)   │ └───────────────┘
                          └─────┬──────┘
                                │
                         ┌──────▼──────┐
                         │  IStorage   │  ← inject Dexie, localStorage, or MemoryStorage
                         └─────────────┘

                     ┌───────────────────────┐
                     │     E2ECrypto         │  ← ECDH P-256 + AES-GCM 256
                     │  (per-peer shared key)│      used by P2PNode._wireCrypto()
                     └───────────────────────┘
```

---

## Module Descriptions

| Module | File | Responsibility |
|--------|------|----------------|
| **P2PNode** | `src/index.js` | Top-level orchestrator; composes all modules |
| **EventBus** | `src/event-bus.js` | Tiny typed event emitter (no Node.js dep) |
| **WebRTCTransport** | `src/transport/webrtc-transport.js` | RTCPeerConnection + DataChannel lifecycle |
| **ISignaling** | `src/signaling/signaling-interface.js` | Interface contract all signaling must implement |
| **NostrSignaling** | `src/signaling/nostr-signaling.js` | Decentralised signaling over public Nostr relays |
| **WebSocketSignaling** | `src/signaling/websocket-signaling.js` | Centralised signaling over your own WS server |
| **MessageRouter** | `src/sync/message-router.js` | Type-based routing + deduplication |
| **GossipSync** | `src/sync/gossip-sync.js` | Item broadcast & incremental sync via gossip |
| **BlobTransfer** | `src/sync/blob-transfer.js` | Chunked binary streaming with backpressure |
| **E2ECrypto** | `src/crypto/e2e-crypto.js` | ECDH P-256 key exchange → AES-GCM 256 |
| **IStorage** | `src/storage/storage-interface.js` | Storage adapter interface |
| **MemoryStorage** | `src/storage/memory-storage.js` | In-memory implementation for dev/testing |
| **utils** | `src/utils.js` | Pure helpers: uuid, ab2hex, hex2ab, sha256hex |

---

## Signaling Options

| | **NostrSignaling** | **WebSocketSignaling** |
|---|---|---|
| Infrastructure | None (uses public Nostr relays) | Requires your own WS server |
| Decentralisation | ✅ Fully decentralised | ❌ Single point (but server only relays) |
| TURN distribution | ❌ (add separate TURN server) | ✅ Server can push TURN credentials |
| Cold-start latency | ~1-4 s (relay connect) | ~50-200 ms |
| Reliability | Depends on relay uptime (7 defaults) | Depends on your server |
| Best for | Open/community apps, no infra | Production deployments |

### NostrSignaling config

```js
new NostrSignaling({
  peerId:   'alice',
  h3Cell:   '8928308280fffff',   // H3 L9 hex cell (geographic channel)
  relays:   ['wss://relay.damus.io'],  // optional, defaults to 7 public relays
  secp256k1: window.secp256k1,         // optional injected module for real Schnorr sigs
})
```

### WebSocketSignaling config

```js
new WebSocketSignaling({
  url:    'wss://signal.example.com',
  peerId: 'alice',
  roomId: 'calgary-h3-cell',    // optional room partitioning
})
```

Minimal server protocol (relay JSON over WS):
```
Client → { type:'announce', peerId, roomId, meta }
Client → { type:'signal',   target, from, signal }

Server → { type:'signal',      from, signal }
Server → { type:'announce',    peerId, meta }
Server → { type:'peer-joined', peerId }
Server → { type:'peer-left',   peerId }
Server → { type:'ice-config',  config: { iceServers, ttl, expiresAt } }
```

---

## Implementing a Custom IStorage

```js
import { IStorage } from '@ourbackyard/p2p-sdk/storage';

class DexieStorage extends IStorage {
  constructor(db) { super(); this.db = db; }

  async getItems(since, limit = 100) {
    return this.db.items.where('timestamp').above(since)
      .reverse().limit(limit).toArray();
  }
  async addItem(item) { await this.db.items.add(item); }
  async hasItem(sellerId, timestamp) {
    return !!(await this.db.items.where('timestamp').equals(timestamp)
      .filter(i => i.sellerId === sellerId).first());
  }
  async hasItemByTitle(sellerId, title) {
    return !!(await this.db.items.where('title').equals(title)
      .filter(i => i.sellerId === sellerId).first());
  }
  async updateItemStatus(itemId, status) {
    await this.db.items.where('itemId').equals(itemId).modify({ status });
  }

  async getBlob(hash)          { return this.db.blobs.where('hash').equals(hash).first() ?? null; }
  async addBlob(hash, blob, meta) { await this.db.blobs.add({ hash, blob, ...meta, timestamp: Date.now() }); }
  async hasBlob(hash)          { return !!(await this.db.blobs.where('hash').equals(hash).first()); }
  async getMissingBlobHashes(hashes) {
    const have = new Set((await this.db.blobs.where('hash').anyOf(hashes).toArray()).map(b => b.hash));
    return hashes.filter(h => !have.has(h));
  }

  async addChatMessage(msg)        { await this.db.chatMessages.put(msg); }
  async getChatMessage(id)         { return this.db.chatMessages.where('id').equals(id).first() ?? null; }
  async markRead(msgId, readAt)    { await this.db.chatMessages.where('id').equals(msgId).modify({ read: true, readAt }); }

  async addDeadDrop(toPeerId, msg) {
    const id = crypto.randomUUID();
    await this.db.deadDrop.add({ id, toPeerId, msg, createdAt: Date.now(), delivered: false });
    return id;
  }
  async getPendingDeadDrop(toPeerId) {
    return this.db.deadDrop.where('toPeerId').equals(toPeerId).filter(r => !r.delivered).toArray();
  }
  async markDelivered(id) { await this.db.deadDrop.update(id, { delivered: true, deliveredAt: Date.now() }); }
}
```

---

## Implementing a Custom ISignaling

```js
import { ISignaling } from '@ourbackyard/p2p-sdk/signaling';

class MySignaling extends ISignaling {
  async connect()                         { /* open channel */ this.emit('status', 'online'); }
  async disconnect()                      { /* close channel */ this.emit('status', 'offline'); }
  async sendSignal(targetPeerId, signal)  { /* relay signal */ }
  async announce(meta = {})              { /* broadcast presence */ }
  get isOnline()                          { return /* true if connected */; }
}

// When a signal arrives from the channel:
//   this.emit('signal', fromPeerId, signal)
// When a peer announces:
//   this.emit('peer:announce', peerId, meta)
```

---

## Migration Guide from p2p-mesh.js

| Old API | SDK equivalent |
|---------|----------------|
| `new OurBackyardMesh({ peerId, h3Cell, db })` | `new P2PNode({ peerId, signaling, storage, iceServers })` |
| `mesh.init()` | `node.start()` |
| `mesh.broadcastItem(item)` | `node.broadcastItem(item)` |
| `mesh.on('item', cb)` | `node.on('item:new', cb)` |
| `mesh.on('chat', cb)` | Register via `node._router.handle('CHAT', cb)` |
| `mesh.sendChat(toPeerId, text)` | `node.send(toPeerId, 'CHAT', { text })` |
| `mesh.destroy()` | `node.stop()` |
| Hardcoded ICE servers | Pass `iceServers: [...]` to `P2PNode` |
| Direct Dexie calls | Implement `DexieStorage extends IStorage` |
| `window.*` bridge hacks | None — SDK is environment-agnostic |

### Known bugs fixed vs p2p-mesh.js

- **Line 260**: `log && log(...)` — `log` was undefined; replaced with `console.log`
- **ICE servers**: Removed hardcoded `openrelay.metered.ca` credentials
- **All `window.*` access**: Removed; SDK works in Workers and Node.js with polyfills

---

## Zero External Dependencies

The SDK uses only browser-native APIs:
- `RTCPeerConnection` / `RTCDataChannel` — WebRTC
- `crypto.subtle` — ECDH key exchange, AES-GCM encryption, SHA-256 hashing
- `WebSocket` — signaling channels

Optional injected dependencies:
- `secp256k1` — for real Schnorr signatures in NostrSignaling (relay may reject events without it)
- Any IStorage implementation (Dexie, localStorage, etc.)---

## License

MIT
