# OurBackyard

A P2P decentralised community marketplace for Calgary neighbourhoods.
No central server for user data, end-to-end encrypted messaging, offline-friendly behaviour, and browser-first deployment.

> npm package: `@ourbackyard/p2p-sdk`

---

## Quick Start

### 1. Install Python dependencies

```bash
python -m pip install fastapi uvicorn websockets
```

### 2. Start the app server

```bash
python -m uvicorn server.server:app --reload --port 7070
```

### 3. Open the app

```text
http://localhost:7070
```

Open a second tab or another device on the same network and click `Join Network`.

---

## Project Structure

```text
OurBackyard-PoC/
├── index.html              # Main PWA entry point
├── manifest.json           # Web app manifest
├── sw.js                   # Service worker
├── package.json
├── README.md
├── STATUS.md
│
├── app/
│   ├── ob-utils.js           # Shared UI utilities
│   ├── p1p2-features.js      # Marketplace and UI feature pack
│   ├── p2p-adapter.js        # SDK adapter entry used for browser bundle
│   ├── desktop-full-node.js  # Desktop full-node bootstrap
│   ├── ui/
│   │   └── chat-ui.js        # Chat modal UI
│   ├── ai/
│   │   └── local-ai.js       # Local semantic search (WebLLM stub)
│   ├── governance/
│   │   └── wot-trust.js      # Web of Trust peer scoring
│   └── security/
│       ├── key-vault.js      # Key management UI
│       └── geo-consent.js    # Geo permission consent flow
│
├── js/
│   ├── ob-sdk.js           # Built browser SDK bundle
│   ├── db.js
│   ├── utils.js
│   ├── dexie.js
│   ├── h3-js.js
│   └── secp256k1.js
│
├── server/
│   ├── server.py           # FastAPI signaling/static server
│   └── start-server.sh
│
├── sdk/
│   ├── src/                # SDK source
│   ├── tests/              # Unit and integration tests
│   └── *.d.ts              # TypeScript declarations
│
├── scripts/
├── coturn/
└── uploads/
```

---

## SDK

The P2P layer is extracted into a framework-agnostic SDK.

### Install

```bash
npm install @ourbackyard/p2p-sdk
```

### Usage

```js
import { P2PNode, NostrSignaling, MemoryStorage } from '@ourbackyard/p2p-sdk';

const node = new P2PNode({
  peerId: 'alice-abc123',
  signaling: new NostrSignaling({
    peerId: 'alice-abc123',
    h3Cell: '8928308280fffff',
  }),
  storage: new MemoryStorage(),
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
});

await node.start();
node.on('peer:connected', peer => console.log('Connected:', peer));
node.on('message', msg => console.log('Msg:', msg));
node.broadcast('HELLO', { text: 'World' });
```

See `sdk/README.md` for the full API.

---

## Development Commands

```bash
npm run build:sdk
npm test
```

---

## Local Test Coordinates

| Location | Lat, Lon |
|---|---|
| Downtown Calgary | 51.0447, -114.0719 |
| NW Edgemont | 51.1285, -114.2103 |
| NW Dalhousie | 51.1138, -114.1946 |

---

## Status

See `STATUS.md` for architecture notes and completed milestones.
                 ��
��������������������������������������������������������������������������������
��  IndexedDB �� CRDT �� Blob streaming   ��
��  KeyVault �� CSP �� Rate limiting      ��
��������������������������������������������������������������������������������
```

---

## Status

See [STATUS.md](STATUS.md) for the full task list and architecture notes.
