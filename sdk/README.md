# @ourbackyard/p2p-sdk

Production-grade modular P2P SDK for OurBackyard — built on WebRTC, Nostr signaling, E2E crypto, and a resilient gossip network.

## Architecture

```
P2PNode (Orchestrator)
├── Layer 0: Foundation      → EventBus, Logger, Config, Utils
├── Layer 1: Identity        → Identity (DID-like), E2ECrypto (ECDH+AES-GCM), Signature (ECDSA), KeyVault
├── Layer 2: Transport       → WebRTCTransport, WebSocketTransport
├── Layer 3: Signaling       → NostrSignaling, WebSocketSignaling, MultiSignaling, LANSignaling
├── Layer 4: Routing         → MessageRouter (O(1) Set dedup, LRU, 50k capacity)
├── Layer 4.5: Sync          → GossipSync (TTL flooding), BlobTransfer (chunked, backpressured)
└── Layer 5: Resilience      → ReconnectManager, HealthMonitor, CircuitBreaker, RateLimiter
```

## Quick Start

```javascript
import P2PNode, { WebSocketSignaling } from '@ourbackyard/p2p-sdk';

const node = new P2PNode({
  signaling: new WebSocketSignaling('wss://signal.example.com'),
});

await node.start();
console.log('My peer ID:', node.id);

// Handle incoming application messages
node.handle('chat', (msg, fromPeerId) => {
  console.log(`${fromPeerId}: ${msg.text}`);
});

// Listen for peer connections
node.on('peer:connected', ({ peerId }) => {
  // Send a message
  node.send(peerId, { type: 'chat', text: 'Hello!' });
});

// Share data via gossip
node.spread('listings', { items: [...] });

// Clean up
await node.stop();
```

## Multi-Signaling (Hybrid Mode)

```javascript
import P2PNode, {
  MultiSignaling, NostrSignaling, WebSocketSignaling, LANSignaling
} from '@ourbackyard/p2p-sdk';

const signaling = new MultiSignaling([
  new NostrSignaling({ relays: ['wss://relay.damus.io', 'wss://relay.snort.social'] }),
  new WebSocketSignaling('wss://signal.ourbackyard.ca'),
  new LANSignaling({ channel: 'calgary-nw' }),
]);

const node = new P2PNode({ signaling });
await node.start();
```

## Key Design Principles

1. **Zero external dependencies** — uses only Web APIs (WebRTC, WebSocket, Web Crypto, BroadcastChannel)
2. **High Cohesion, Low Coupling** — single responsibility per module, event-driven communication
3. **Interface-driven** — `ITransport`, `ISignaling`, `IStorage` for pluggable backends
4. **Defensive coding** — all public methods validate inputs, all async ops have error boundaries
5. **Observable** — every state change emits an event
6. **Testable** — pure functions where possible, dependency injection everywhere

## Running Tests

```bash
cd sdk
npm install
npm test
```

## Signaling Server

The SDK ships with a minimal signaling server contract. Your server only needs to handle 3 message types:

- `announce` — peer came online
- `signal` — relay offer/answer/ICE to target peer
- `ping/pong` — heartbeat

See `signaling-server/` for a reference implementation (~80 lines Python/Node.js).

## Capacity Planning

| Scale | Signaling Load | Notes |
|-------|---------------|-------|
| 1,000 DAU | ~5 MB/day | Old laptop handles it |
| 100,000 DAU | ~500 MB/day | Single VPS ($5/mo) |
| 1M DAU | ~5 GB/day | 3-5 nodes, ~$15-25/mo |

After the initial handshake, **all data flows P2P** — the signaling server goes idle.
