# Runtime Convergence Matrix (Legacy vs Native)

## Goal
Keep one production runtime path (`native/* + PS2`) and make legacy behavior explicit, temporary, and test-gated.

## Keep (Primary Path)
- `native/communication/p2p-mesh.js`
  - Role: transport, route recovery, dead-drop, chat media stream.
  - Status: **primary runtime**.
- `native/communication/nostr-signaling.js`
  - Role: decentralized signaling + relay fallback.
  - Status: **primary runtime**.
- `src/ps2/*`
  - Role: reliable mailbox, IM/market op-log, sync protocol.
  - Status: **primary runtime**.
- `src/bootstrap/ps2-bridge.js`
  - Role: startup bridge between PS2 and runtime mesh.
  - Status: **primary runtime**.
- `src/bootstrap/write-paths.js`
  - Role: single write gateway for item/chat/community persistence.
  - Status: **primary runtime**.

## Keep (Compatibility Layer, Planned Reduction)
- `index.html` inline boot wiring
  - Role: page bootstrap and compatibility glue.
  - Status: **temporary compatibility layer**.
  - Rule: new bridge logic moves to `src/bootstrap/*`, inline only calls module entrypoints.
- `p1p2-features.js`
  - Role: feature UI and community channel UX.
  - Status: **temporary compatibility layer**.
  - Rule: community persistence must call `window.__OB_WRITE_PATHS`.

## Deprecated / No New Features
- `server.py` WebSocket relay flow (dev fallback only)
  - Status: **deprecated for production path**.
  - Rule: no new feature work on server relay semantics.
- Direct DB writes in feature scripts for item/chat/community
  - Status: **deprecated**.
  - Rule: route through write gateway (`src/bootstrap/write-paths.js`).

## Removal Checklist (When All Green)
1. `index.html` has no PS2 event-specific DB write code.
2. `p1p2-features.js` community writes are gateway-only.
3. Contract tests cover:
   - PS2 -> UI chat payload normalization
   - Mesh -> PS2 frame validation
4. E2E smoke passes for:
   - IM text/media persistence across refresh
   - Market publish/update/delete convergence
   - Community channel replay after refresh

## Anti-Drift Guardrails
- Any new write path touching `items`, `chatMessagesV2`, or community store must be implemented in `src/bootstrap/write-paths.js`.
- Any new transport frame entering PS2 must pass `validatePS2FrameMessage`.
- Any new PS2 event mapped to UI must pass `normalizePS2UIChatEvent` (or equivalent contract helper).
