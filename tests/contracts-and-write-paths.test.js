import { describe, expect, it, vi } from "vitest";
import {
    validatePS2UIChatEvent,
    normalizePS2UIChatEvent,
} from "../src/contracts/ps2-ui-contract.js";
import { validatePS2FrameMessage } from "../src/contracts/mesh-ps2-contract.js";
import { createWritePaths } from "../src/bootstrap/write-paths.js";

function makeTableById() {
    const rows = new Map();
    return {
        rows,
        async put(row) {
            rows.set(String(row.id), { ...row });
        },
        where(field) {
            if (field !== "id") {
                throw new Error(`unsupported field: ${field}`);
            }
            return {
                equals(value) {
                    return {
                        first: async () => rows.get(String(value)) || null,
                    };
                },
            };
        },
    };
}

function makeKVTable() {
    const kv = new Map();
    return {
        kv,
        async get(key) {
            return kv.get(String(key)) || null;
        },
        async put(record) {
            kv.set(String(record.key), { ...record });
        },
    };
}

describe("PS2/UI contract", () => {
    it("validates chat payload shape", () => {
        expect(validatePS2UIChatEvent(null).ok).toBe(false);
        expect(validatePS2UIChatEvent({ text: "" }).ok).toBe(false);
        expect(validatePS2UIChatEvent({ text: "hello" }).ok).toBe(true);
        expect(validatePS2UIChatEvent({ mediaType: "image" }).ok).toBe(true);
    });

    it("normalizes sender/recipient IDs for direction aware events", () => {
        const outgoing = normalizePS2UIChatEvent(
            { text: "hi", to: "peer_b" },
            { direction: "out", localUserId: "peer_a", now: () => 123 },
        );
        expect(outgoing.direction).toBe("out");
        expect(outgoing.senderUserId).toBe("peer_a");
        expect(outgoing.recipientUserId).toBe("peer_b");
        expect(outgoing.ts).toBe(123);

        const incoming = normalizePS2UIChatEvent(
            { text: "yo", from: "peer_b" },
            { direction: "in", localUserId: "peer_a", now: () => 456 },
        );
        expect(incoming.direction).toBe("in");
        expect(incoming.senderUserId).toBe("peer_b");
        expect(incoming.recipientUserId).toBe("peer_a");
        expect(incoming.ts).toBe(456);
    });
});

describe("Mesh/PS2 frame contract", () => {
    it("accepts valid PS2 event frame", () => {
        const valid = validatePS2FrameMessage({
            type: "PS2_FRAME",
            frame: {
                v: 1,
                kind: "event",
                id: "ev_1",
                from: "peer_a",
                topic: "im",
                op: "send",
                body: { text: "hi" },
                ts: 1,
            },
        });
        expect(valid.ok).toBe(true);
    });

    it("rejects wrong frame versions", () => {
        const invalid = validatePS2FrameMessage({
            type: "PS2_FRAME",
            frame: {
                v: 2,
                kind: "event",
                id: "ev_2",
                from: "peer_a",
                topic: "im",
                op: "send",
            },
        });
        expect(invalid.ok).toBe(false);
        expect(invalid.reason).toBe("wrong_version");
    });
});

describe("Single write paths", () => {
    it("routes chat writes and read receipts through write gateway", async () => {
        const chatMessagesV2 = makeTableById();
        const db = { chatMessagesV2 };
        const onChat = vi.fn();
        const writePaths = createWritePaths({
            db,
            mesh: { onChat },
            localUserId: "peer_a",
            localPeerId: "peer_a",
        });

        const written = await writePaths.writeChatMessage(
            { id: "msg_1", text: "hello", to: "peer_b" },
            { direction: "out", emitToUI: true },
        );
        expect(written.ok).toBe(true);
        expect(chatMessagesV2.rows.get("msg_1").direction).toBe("out");
        expect(onChat).toHaveBeenCalledTimes(1);

        const marked = await writePaths.markChatRead({
            id: "msg_1",
            from: "peer_b",
            to: "peer_a",
            ts: 999,
        });
        expect(marked.ok).toBe(true);
        expect(chatMessagesV2.rows.get("msg_1").read).toBe(true);
        expect(chatMessagesV2.rows.get("msg_1").readAt).toBe(999);
    });

    it("deduplicates and persists community messages through one store key", async () => {
        const userData = makeKVTable();
        const db = { userData };
        const writePaths = createWritePaths({
            db,
            localPeerId: "peer_a",
        });
        const channels = [{ id: "general" }, { id: "free" }];
        const state = { general: [], free: [] };

        const one = writePaths.mergeCommunityMessage(state, {
            channel: "general",
            from: "peer_a",
            name: "A",
            text: "hello",
            ts: 100,
        });
        const dup = writePaths.mergeCommunityMessage(state, {
            channel: "general",
            from: "peer_a",
            name: "A",
            text: "hello",
            ts: 100,
        });

        expect(one.added).toBe(true);
        expect(dup.added).toBe(false);
        await writePaths.persistCommunitySnapshot(state, {
            channels,
            storeKey: "community_test_v2",
        });
        const loaded = await writePaths.loadCommunitySnapshot({
            channels,
            storeKey: "community_test_v2",
        });
        expect(loaded.general.length).toBe(1);
        expect(loaded.general[0].text).toBe("hello");
    });

    it("normalizes market item writes before save handler", async () => {
        const saveNeighborItem = vi.fn(async () => {});
        const writePaths = createWritePaths({
            db: {},
            saveNeighborItem,
        });
        const res = await writePaths.writeMarketItem({
            itemId: "42",
            sellerId: "peer_seller",
            imageHash: "img_1",
            ts: 123,
        });
        expect(res.ok).toBe(true);
        expect(saveNeighborItem).toHaveBeenCalledTimes(1);
        const saved = saveNeighborItem.mock.calls[0][0];
        expect(saved.id).toBe("42");
        expect(saved.imageHashes).toEqual(["img_1"]);
    });
});
