import { describe, expect, it, vi } from "vitest";
import { MeshTransportAdapter } from "../src/ps2/transport/MeshTransportAdapter.js";

function makeMesh({
    resolved = null,
    openPeerIds = [],
    sendResultByTarget = {},
    peerMetaRows = [],
} = {}) {
    const calls = [];
    const dataChannels = new Map(openPeerIds.map((id) => [id, { readyState: "open" }]));
    const peerMeta = new Map(peerMetaRows.map((row) => [row.peerId, row.meta]));
    const kickstarts = [];
    return {
        calls,
        dataChannels,
        peerMeta,
        kickstarts,
        resolvePeerTarget(target) {
            return resolved ?? target;
        },
        _send(target, payload) {
            calls.push({ target, payload });
            if (Object.prototype.hasOwnProperty.call(sendResultByTarget, target)) {
                return !!sendResultByTarget[target];
            }
            return true;
        },
        _kickstartChatRoute(target) {
            kickstarts.push(target);
        },
    };
}

describe("MeshTransportAdapter", () => {
    it("uses resolved session route first", () => {
        const mesh = makeMesh({
            resolved: "peer_sess_b2",
            sendResultByTarget: { peer_sess_b2: true },
        });
        const adapter = new MeshTransportAdapter(mesh);

        const ok = adapter.send("peer_user_b", { kind: "event", id: "1" });
        expect(ok).toBe(true);
        expect(mesh.calls.length).toBe(1);
        expect(mesh.calls[0].target).toBe("peer_sess_b2");
    });

    it("falls back to logical user id when resolved route fails", () => {
        const mesh = makeMesh({
            resolved: "peer_sess_old",
            sendResultByTarget: {
                peer_sess_old: false,
                peer_user_b: true,
            },
        });
        const adapter = new MeshTransportAdapter(mesh);

        const ok = adapter.send("peer_user_b", { kind: "event", id: "2" });
        expect(ok).toBe(true);
        expect(mesh.calls.map((c) => c.target)).toEqual(["peer_sess_old", "peer_user_b"]);
    });

    it("falls back to the sole open channel when route map is temporarily stale", () => {
        const mesh = makeMesh({
            resolved: "peer_sess_missing",
            openPeerIds: ["peer_sess_live"],
            sendResultByTarget: {
                peer_sess_missing: false,
                peer_user_b: false,
                peer_sess_live: true,
            },
        });
        const adapter = new MeshTransportAdapter(mesh);

        const ok = adapter.send("peer_user_b", { kind: "event", id: "3" });
        expect(ok).toBe(true);
        expect(mesh.calls.map((c) => c.target)).toEqual([
            "peer_sess_missing",
            "peer_user_b",
            "peer_sess_live",
        ]);
    });

    it("falls back to peerMeta-mapped channel when multiple channels are open", () => {
        const mesh = makeMesh({
            resolved: "peer_sess_old",
            openPeerIds: ["peer_sess_other", "peer_sess_live"],
            peerMetaRows: [
                { peerId: "peer_sess_live", meta: { userId: "peer_user_b" } },
                { peerId: "peer_sess_other", meta: { userId: "peer_user_c" } },
            ],
            sendResultByTarget: {
                peer_sess_old: false,
                peer_user_b: false,
                peer_sess_live: true,
            },
        });
        const adapter = new MeshTransportAdapter(mesh);

        const ok = adapter.send("peer_user_b", { kind: "event", id: "4" });
        expect(ok).toBe(true);
        expect(mesh.calls.map((c) => c.target)).toEqual([
            "peer_sess_old",
            "peer_user_b",
            "peer_sess_live",
        ]);
    });

    it("triggers kickstart when all route attempts fail", () => {
        const mesh = makeMesh({
            resolved: "peer_sess_old",
            openPeerIds: ["peer_sess_x", "peer_sess_y"],
            peerMetaRows: [
                { peerId: "peer_sess_x", meta: { userId: "peer_user_b" } },
                { peerId: "peer_sess_y", meta: { userId: "peer_user_b" } },
            ],
            sendResultByTarget: {
                peer_sess_old: false,
                peer_user_b: false,
                peer_sess_x: false,
                peer_sess_y: false,
            },
        });
        const adapter = new MeshTransportAdapter(mesh);

        const ok = adapter.send("peer_user_b", { kind: "event", id: "5" });
        expect(ok).toBe(false);
        expect(mesh.kickstarts).toEqual(["peer_user_b"]);
    });

    it("drops invalid PS2_FRAME payloads before invoking handler", async () => {
        const mesh = makeMesh();
        const adapter = new MeshTransportAdapter(mesh);
        const handler = vi.fn(async () => {});
        adapter.setMessageHandler(handler);

        const invalid = await adapter.consumeMeshMessage({
            type: "PS2_FRAME",
            frame: { v: 2, kind: "event", id: "x" },
        });
        expect(invalid).toBe(false);
        expect(handler).not.toHaveBeenCalled();

        const valid = await adapter.consumeMeshMessage({
            type: "PS2_FRAME",
            frame: {
                v: 1,
                kind: "event",
                id: "ev_1",
                from: "peer_a",
                topic: "im",
                op: "send",
                body: { text: "ok" },
                ts: 1,
            },
        });
        expect(valid).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
