# _experimental/

These files are **archived, not deleted**. They are not loaded by the app.

## Why they're here

| Category | Files | Reason |
|---|---|---|
| Browser-impossible | `mlx-npu-accelerator.js`, `tee-secure-enclave.js`, `homomorphic-search.js`, `post-quantum-crypto.js`, `h3-vector-index.js` | Require native hardware access (NPU, TrustZone, SEAL) unavailable in browser sandbox |
| Missing deps | `libp2p.js`, `circuit-relay.js`, `hyperswarm-dht.js` | Require npm bundler; dynamic imports can't resolve in browser |
| Broken deps | `zk-storage-proof.js`, `holographic-storage.js` | Reference `./merkletree.js` which doesn't exist |
| Research-grade | `incremental-snapshots.js`, `trusted-compute-offload.js` | Correct concepts, but impractical at current network scale |
| Future products | `liquid-democracy.js`, `zk-timebanking.js`, `dtn-data-mule.js` | Valid ideas, wrong product scope for v1 Calgary marketplace |
| Redundant | `ai-assistant.js`, `privacy-budget-manager.js`, `intent-routing.js` | Duplicates functionality already in `local-ai.js` + `p2p-mesh.js` |

## To revive any of these

1. Move the file back to the appropriate `native/` subfolder
2. Resolve any blocking issues listed above
3. Add a `<script src="...">` tag in `index.html`
4. Add an init block in `OurBackyardBoot()` in `index.html`

Do **not** load these files directly — they will throw errors or silently do nothing.
