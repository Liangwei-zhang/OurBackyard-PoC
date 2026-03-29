import { validatePS2FrameMessage } from "../../contracts/mesh-ps2-contract.js";

/**
 * Adapter for OurBackyardMesh.
 *
 * Usage:
 * 1) Create adapter with mesh instance.
 * 2) Pass adapter into PS2Kernel.
 * 3) In mesh data routing, call adapter.consumeMeshMessage(msg) when msg.type === "PS2_FRAME".
 */
export class MeshTransportAdapter {
    constructor(mesh) {
        this.mesh = mesh;
        this.handler = null;
    }

    setMessageHandler(handler) {
        this.handler = handler;
    }

    send(toPeerId, frame) {
        if (!toPeerId) return false;
        const payload = {
            type: "PS2_FRAME",
            frame,
        };
        const tried = new Set();
        const candidates = [];
        const resolved = this.mesh?.resolvePeerTarget?.(toPeerId) || null;
        if (resolved) candidates.push(resolved);
        if (toPeerId && toPeerId !== resolved) candidates.push(toPeerId);

        // Fallback for transient route-map loss after peer refresh:
        // if there is exactly one open channel, send there.
        const openChannels = this.mesh?.dataChannels;
        if (openChannels?.size === 1) {
            const [solePeerId] = openChannels.keys();
            if (solePeerId) candidates.push(solePeerId);
        }

        const peerMetaEntries = this.mesh?.peerMeta?.entries?.();
        if (peerMetaEntries) {
            for (const [sessionPeerId, meta] of peerMetaEntries) {
                if (!sessionPeerId) continue;
                const mappedUserId = meta?.userId || meta?.peerId || null;
                if (mappedUserId === toPeerId) candidates.push(sessionPeerId);
            }
        }

        for (const target of candidates) {
            if (!target || tried.has(target)) continue;
            tried.add(target);
            const ok = !!this.mesh?._send?.(target, payload);
            if (ok) return true;
        }
        // If all route attempts failed, actively kickstart route recovery.
        this.mesh?._kickstartChatRoute?.(toPeerId);
        return false;
    }

    broadcast(frame) {
        this.mesh?._flood?.({
            type: "PS2_FRAME",
            frame,
        });
        return true;
    }

    listPeers() {
        if (typeof this.mesh?.listActiveUsers === "function") {
            return this.mesh.listActiveUsers();
        }
        const keys = this.mesh?.dataChannels?.keys?.();
        if (!keys) return [];
        return [...keys].filter(Boolean);
    }

    async consumeMeshMessage(msg) {
        if (!this.handler) return false;
        const valid = validatePS2FrameMessage(msg);
        if (!valid.ok) return false;
        await this.handler(msg.frame);
        return true;
    }
}
