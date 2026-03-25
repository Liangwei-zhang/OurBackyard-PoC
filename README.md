# OurBackyard

A P2P decentralised community marketplace for Calgary neighbourhoods.  
No central server for data ¡ª end-to-end encrypted, works offline, data stays with users.

> npm package: [`@ourbackyard/p2p-sdk`](https://www.npmjs.com/package/@ourbackyard/p2p-sdk)

---

## Quick Start

### 1. Start the signaling server

```bash
pip install fastapi uvicorn websockets
python server.py
# or: bash start-server.sh
```

### 2. Open the app

```
http://localhost:8000
```

Open a second tab (or another device on the same network) and click **Join Network**.

---

## Project Structure

```
OurBackyard-PoC/
©À©¤©¤ index.html              # PWA entry point (single-file app, 8 k lines)
©À©¤©¤ index-v2.html           # Vite modular build target
©À©¤©¤ ob-utils.js             # Shared UI utilities (escape, notify, compress)
©À©¤©¤ p1p2-features.js        # Core UI feature logic
©À©¤©¤ manifest.json / sw.js   # PWA manifest + service worker
©À©¤©¤ server.py               # FastAPI WebSocket signaling server
©À©¤©¤ vite.config.js          # Vite build config for index-v2
©À©¤©¤ vite.sdk.config.js      # Vite build config for the SDK bundle
©À©¤©¤ package.json
©¦
©À©¤©¤ js/                     # Standalone JS vendored libraries
©¦   ©À©¤©¤ ob-sdk.js           # Pre-built SDK IIFE bundle (window.OurBackyardMesh)
©¦   ©À©¤©¤ db.js               # IndexedDB (Dexie wrapper)
©¦   ©À©¤©¤ utils.js            # Helper utilities
©¦   ©À©¤©¤ dexie.js            # Dexie library
©¦   ©À©¤©¤ h3-js.js            # H3 geospatial library
©¦   ©¸©¤©¤ secp256k1.js        # secp256k1 cryptography
©¦
©À©¤©¤ native/                 # Native UI + helper modules loaded by index.html
©¦   ©À©¤©¤ ui/                 # Chat UI, P2P image components
©¦   ©À©¤©¤ ai/                 # Local AI assistant
©¦   ©À©¤©¤ governance/         # Web-of-Trust
©¦   ©¸©¤©¤ security/           # KeyVault, GeoConsent
©¦
©À©¤©¤ sdk/                    # @ourbackyard/p2p-sdk ¡ª 6-layer P2P SDK
©¦   ©À©¤©¤ src/                # Source (ES Modules, zero external deps)
©¦   ©À©¤©¤ tests/              # 325 unit tests
©¦   ©¸©¤©¤ *.d.ts              # TypeScript declarations
©¦
©À©¤©¤ scripts/                # Build helpers (bundle-app, delta-bundle)
©À©¤©¤ coturn/                 # Self-hosted TURN server config
©¸©¤©¤ uploads/                # User-uploaded image assets
```

---

## SDK

The P2P logic is extracted into a standalone, framework-agnostic SDK.

### Install

```bash
npm install @ourbackyard/p2p-sdk
```

### Usage

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
node.on('message',        msg  => console.log('Msg:', msg));
node.broadcast('HELLO', { text: 'World' });
```

See [`sdk/README.md`](sdk/README.md) for the full API.

---

## Running Tests

```bash
node --test sdk/tests/*.test.js
# 325 tests, 0 failures
```

## Building the SDK bundle

```bash
npm run build:sdk   # outputs js/ob-sdk.js
```

---

## H3 Test Coordinates (Calgary)

| Location | Lat, Lon | H3 L9 |
|---|---|---|
| Downtown | 51.0447, -114.0719 | 8fb29a¡­ |
| NW Edgemont | 51.1285, -114.2103 | 8fb2c8¡­ |
| NW Dalhousie | 51.1138, -114.1946 | 8fb2b1¡­ |

---

## P2P Architecture

```
©°©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©´
©¦            OurBackyard PWA           ©¦
©¦  index.html ¡¤ chat-ui ¡¤ p1p2-feats   ©¦
©¸©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©Ð©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¼
                 ©¦ uses
©°©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤¨‹©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©´
©¦          @ourbackyard/p2p-sdk        ©¦
©¦  WebRTC ?©¤? Nostr signaling (7)      ©¦
©¦  GossipSub ¡¤ ECDH E2E ¡¤ Dead Drop    ©¦
©¦  MultiSignaling failover             ©¦
©¸©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©Ð©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¼
                 ©¦
©°©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤¨‹©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©´
©¦  IndexedDB ¡¤ CRDT ¡¤ Blob streaming   ©¦
©¦  KeyVault ¡¤ CSP ¡¤ Rate limiting      ©¦
©¸©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¼
```

---

## Status

See [STATUS.md](STATUS.md) for the full task list and architecture notes.
