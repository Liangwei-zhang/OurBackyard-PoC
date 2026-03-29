import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = MockWebSocket.CONNECTING;
        this.sent = [];
        MockWebSocket.instances.push(this);
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onclose) this.onclose();
    }
}

describe("services", () => {
    beforeAll(async () => {
        await __loadScript("src/services/auth.js");
        await __loadScript("src/services/db.js");
        await __loadScript("src/services/imageUtils.js");
        await __loadScript("src/services/moderator.js");
        await __loadScript("src/services/websocket.js");
        await __loadScript("src/services/p2p.js");
    });

    beforeEach(() => {
        __resetDom();
        window.peerId = "peer-self";
        window.displayName = "Tester";
        window.roomId = "room-test";
        MockWebSocket.instances = [];
        vi.restoreAllMocks();
    });

    it("DID service can sign and verify messages", async () => {
        window.DIDService.clearKeys();
        await window.DIDService.init();
        expect(window.DIDService.hasKeyPair()).toBe(true);

        const message = { a: 1, b: "x" };
        const signature = await window.DIDService.sign(message);
        const valid = await window.DIDService.verify(message, signature, window.DIDService.getDID());
        expect(valid).toBe(true);

        window.DIDService.clearKeys();
        expect(localStorage.getItem("did_publicKey")).toBeNull();
    });

    it("DB service initializes expected tables", () => {
        const db = window.DBService.init();
        const names = db.tables.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(["items", "blobs", "sync", "userData", "blocklist"]));
        db.close();
    });

    it("image utils hash and object-url manager work", async () => {
        const hash = await window.ImageUtils.computeImageHash(new Blob(["abc"], { type: "text/plain" }));
        expect(hash).toBe(SHA256_ABC);

        const manager = window.ImageUtils.ObjectUrlManager;
        manager.clear();
        const originalMax = manager.maxCacheSize;
        manager.maxCacheSize = 2;

        const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
        manager.getOrCreate("h1", new Blob(["1"]));
        manager.getOrCreate("h2", new Blob(["2"]));
        manager.getOrCreate("h3", new Blob(["3"]));

        expect(manager.urls.size).toBe(2);
        expect(revokeSpy).toHaveBeenCalled();

        manager.maxCacheSize = originalMax;
        manager.clear();
    });

    it("blob saving and quota cleanup call db layer correctly", async () => {
        const put = vi.fn().mockResolvedValue(undefined);
        const del = vi.fn().mockResolvedValue(undefined);
        window.db = {
            blobs: {
                put,
                count: vi.fn().mockResolvedValue(120),
                orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                        toArray: vi.fn().mockResolvedValue([{ hash: "a" }, { hash: "b" }]),
                    }),
                }),
                delete: del,
            },
            transaction: async (_mode, _table, cb) => cb(),
        };

        await window.ImageUtils.saveBlobWithQuotaCheck("h", new Blob(["x"]));
        expect(put).toHaveBeenCalled();

        await window.ImageUtils.cleanupOldBlobs();
        expect(del).toHaveBeenCalledTimes(2);
    });

    it("content moderator loads/reports/unblocks correctly", async () => {
        const put = vi.fn().mockResolvedValue(undefined);
        const del = vi.fn().mockResolvedValue(undefined);
        window.db = {
            blocklist: {
                toArray: vi.fn().mockResolvedValue([{ itemHash: "blocked-1" }]),
                put,
                where: vi.fn().mockReturnValue({
                    equals: vi.fn().mockReturnValue({
                        delete: del,
                    }),
                }),
            },
        };
        window.Utils = { showToast: vi.fn() };

        await window.ContentModerator.init();
        expect(window.ContentModerator.isBlocked("blocked-1")).toBe(true);

        await window.ContentModerator.reportItem("item-2", "spam");
        expect(put).toHaveBeenCalled();
        expect(window.ContentModerator.isBlocked("item-2")).toBe(true);
        expect(window.Utils.showToast).toHaveBeenCalled();

        await window.ContentModerator.unblockItem("item-2");
        expect(del).toHaveBeenCalled();
        expect(window.ContentModerator.isBlocked("item-2")).toBe(false);

        const filtered = window.ContentModerator.filterItems([
            { id: "blocked-1" },
            { id: "ok-1" },
        ]);
        expect(filtered.map((i) => i.id)).toEqual(["ok-1"]);
    });

    it("websocket service connects, authenticates and handles incoming messages", async () => {
        globalThis.WebSocket = MockWebSocket;

        const putItem = vi.fn().mockResolvedValue(undefined);
        const updateItem = vi.fn().mockResolvedValue(undefined);
        const firstByItemId = vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 99, itemId: "item-2" });

        window.db = {
            items: {
                where: vi.fn().mockImplementation((field) => ({
                    equals: vi.fn().mockImplementation((value) => ({
                        first: () => {
                            if (field === "itemId") return firstByItemId(value);
                            return Promise.resolve(null);
                        },
                    })),
                })),
                put: putItem,
                update: updateItem,
            },
            blobs: {
                where: vi.fn().mockReturnValue({
                    equals: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue(null),
                    }),
                }),
            },
        };

        window.loadItems = vi.fn();
        window.ImageUtils = { saveBlobWithQuotaCheck: vi.fn().mockResolvedValue(undefined) };

        window.WSService.connect("wss://example.test/ws");
        const socket = MockWebSocket.instances[0];
        expect(socket).toBeTruthy();

        socket.readyState = MockWebSocket.OPEN;
        await socket.onopen();
        expect(socket.sent.map((m) => m.type)).toEqual(expect.arrayContaining(["AUTH", "HANDSHAKE"]));
        expect(window.WSService.getStatus()).toBe("connected");

        await socket.onmessage({
            data: JSON.stringify({
                type: "NEW_ITEM",
                itemId: "item-1",
                title: "Chair",
            }),
        });
        await __flushPromises();
        expect(putItem).toHaveBeenCalled();
        expect(window.loadItems).toHaveBeenCalled();

        await socket.onmessage({
            data: JSON.stringify({
                type: "ITEM_UPDATE",
                itemId: "item-2",
                status: "pending",
                price: 20,
                timestamp: 1,
            }),
        });
        await __flushPromises();
        expect(updateItem).toHaveBeenCalledWith(99, expect.objectContaining({ status: "pending", price: 20 }));

        await socket.onmessage({
            data: JSON.stringify({
                type: "IMG_CHUNK",
                imageHash: "h1",
                data: btoa("abc"),
                offset: 0,
                expectedSize: 3,
            }),
        });
        expect(window.ImageUtils.saveBlobWithQuotaCheck).toHaveBeenCalledWith("h1", expect.any(Blob));
    });

    it("p2p streamer can broadcast, dispatch chat and cleanup peers", async () => {
        const dcOpen = { readyState: "open", send: vi.fn(), close: vi.fn() };
        const dcClosed = { readyState: "closed", send: vi.fn(), close: vi.fn() };
        const pc = { close: vi.fn() };

        window.P2PStreamer.dataChannels.set("p1", dcOpen);
        window.P2PStreamer.dataChannels.set("p2", dcClosed);
        window.P2PStreamer.peerConnections.set("p1", pc);

        const handler = vi.fn();
        window.addEventListener("p2p-chat", handler);
        window.P2PStreamer.handleChatMessage({ type: "CHAT_MESSAGE", message: "hi" });
        expect(handler).toHaveBeenCalled();

        window.P2PStreamer.broadcast({ type: "NEW_ITEM", id: 1 });
        expect(dcOpen.send).toHaveBeenCalledTimes(1);
        expect(dcClosed.send).not.toHaveBeenCalled();

        const sent = await window.P2PStreamer.sendImage("missing", new Blob(["img"], { type: "image/jpeg" }));
        expect(sent).toBe(false);

        window.P2PStreamer.removePeer("p1");
        expect(pc.close).toHaveBeenCalled();
        expect(dcOpen.close).toHaveBeenCalled();
        expect(window.P2PStreamer.getPeers()).toEqual([]);
    });
});
