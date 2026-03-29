import { describe, expect, it, vi } from "vitest";
import { PS2Kernel } from "../src/ps2/PS2Kernel.js";

class TestNetwork {
    constructor() {
        this.adapters = new Map();
        this.dropFirstIMFromA = true;
        this.blocked = new Set();
    }

    register(nodeId, adapter) {
        this.adapters.set(nodeId, adapter);
    }

    disconnect(a, b) {
        this.blocked.add(`${a}->${b}`);
        this.blocked.add(`${b}->${a}`);
    }

    connect(a, b) {
        this.blocked.delete(`${a}->${b}`);
        this.blocked.delete(`${b}->${a}`);
    }

    _isBlocked(from, to) {
        return this.blocked.has(`${from}->${to}`);
    }

    deliver(from, to, frame) {
        if (this._isBlocked(from, to)) return;
        if (this.dropFirstIMFromA && from === "A" && to === "B" && frame.kind === "event" && frame.topic === "im") {
            this.dropFirstIMFromA = false;
            return;
        }
        const target = this.adapters.get(to);
        if (!target?.handler) return;
        target.handler(frame);
    }

    broadcast(from, frame) {
        for (const [peerId, adapter] of this.adapters.entries()) {
            if (peerId === from) continue;
             if (this._isBlocked(from, peerId)) continue;
            if (adapter?.handler) adapter.handler(frame);
        }
    }
}

class TestTransportAdapter {
    constructor(nodeId, network) {
        this.nodeId = nodeId;
        this.network = network;
        this.handler = null;
        network.register(nodeId, this);
    }

    setMessageHandler(handler) {
        this.handler = handler;
    }

    send(to, frame) {
        this.network.deliver(this.nodeId, to, frame);
        return true;
    }

    broadcast(frame) {
        this.network.broadcast(this.nodeId, frame);
        return true;
    }
}

function waitFor(predicate, timeoutMs = 2000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) {
                resolve();
                return;
            }
            if (Date.now() - started > timeoutMs) {
                reject(new Error("waitFor timeout"));
                return;
            }
            setTimeout(tick, 20);
        };
        tick();
    });
}

describe("PS2 framework", () => {
    it("retries reliable IM messages and converges on delivered status", async () => {
        vi.useRealTimers();
        const network = new TestNetwork();

        const kernelA = new PS2Kernel({
            nodeId: "A",
            transport: new TestTransportAdapter("A", network),
            mailboxOptions: {
                retryMs: 30,
                tickMs: 10,
                maxRetries: 6,
            },
        });
        const kernelB = new PS2Kernel({
            nodeId: "B",
            transport: new TestTransportAdapter("B", network),
            mailboxOptions: {
                retryMs: 30,
                tickMs: 10,
                maxRetries: 6,
            },
        });

        kernelA.start();
        kernelB.start();

        const msgId = await kernelA.im.sendText("B", "hello ps2", { id: "msg_custom_1" });
        expect(msgId).toBe("msg_custom_1");

        await waitFor(() => {
            const incoming = kernelB.store.listConversation("A", "B");
            return incoming.some((m) => m.text === "hello ps2");
        });

        const sent = kernelA.store.getMessage(msgId);
        expect(sent.status).toBe("delivered");

        kernelA.stop();
        kernelB.stop();
    });

    it("syncs media IM metadata and read receipts", async () => {
        const network = new TestNetwork();
        network.dropFirstIMFromA = false;

        const kernelA = new PS2Kernel({
            nodeId: "A",
            transport: new TestTransportAdapter("A", network),
            mailboxOptions: { retryMs: 20, tickMs: 10, maxRetries: 5 },
        });
        const kernelB = new PS2Kernel({
            nodeId: "B",
            transport: new TestTransportAdapter("B", network),
            mailboxOptions: { retryMs: 20, tickMs: 10, maxRetries: 5 },
        });
        kernelA.start();
        kernelB.start();

        const msgId = await kernelA.im.sendMedia("B", {
            mediaType: "image",
            cid: "cid://image-1",
            hash: "hash-1",
            bytes: 1234,
            mimeType: "image/jpeg",
            text: "photo",
        });

        await waitFor(() => !!kernelB.store.getMessage(msgId));
        const incoming = kernelB.store.getMessage(msgId);
        expect(incoming.media.mediaType).toBe("image");
        expect(incoming.media.cid).toBe("cid://image-1");
        expect(incoming.senderUserId).toBe("A");
        expect(incoming.recipientUserId).toBe("B");

        await kernelB.im.markRead("A", msgId);
        await waitFor(() => kernelA.store.getMessage(msgId)?.status === "read");
        expect(kernelA.store.getMessage(msgId).status).toBe("read");

        kernelA.stop();
        kernelB.stop();
    });

    it("replicates market create/update/delete via decentralized op broadcast", async () => {
        const network = new TestNetwork();
        network.dropFirstIMFromA = false;

        const kernelA = new PS2Kernel({
            nodeId: "A",
            transport: new TestTransportAdapter("A", network),
        });
        const kernelB = new PS2Kernel({
            nodeId: "B",
            transport: new TestTransportAdapter("B", network),
        });
        kernelA.start();
        kernelB.start();

        const itemId = kernelA.market.publishItem({
            title: "Mountain Bike",
            price: 900,
            category: "Sports",
            imageHash: "img_hash_1",
            imageHashes: ["img_hash_1", "img_hash_2"],
            condition: "Used",
            h3Index: "8928308280fffff",
        });
        await waitFor(() => !!kernelB.market.getItem(itemId));
        expect(kernelB.market.getItem(itemId).title).toBe("Mountain Bike");
        expect(kernelB.market.getItem(itemId).ownerUserId).toBe("A");
        expect(kernelB.market.getItem(itemId).imageHash).toBe("img_hash_1");
        expect(kernelB.market.getItem(itemId).imageHashes).toEqual(["img_hash_1", "img_hash_2"]);
        expect(kernelB.market.getItem(itemId).condition).toBe("Used");
        expect(kernelB.market.getItem(itemId).h3Index).toBe("8928308280fffff");

        kernelA.market.updateItem(itemId, { price: 750, status: "pending" });
        await waitFor(() => kernelB.market.getItem(itemId)?.price === 750);
        expect(kernelB.market.getItem(itemId).status).toBe("pending");

        kernelA.market.deleteItem(itemId);
        await waitFor(() => kernelB.market.getItem(itemId)?.deleted === true);
        expect(kernelB.market.getItem(itemId).status).toBe("gone");

        kernelA.stop();
        kernelB.stop();
    });

    it("recovers missed market updates after reconnect via sync request", async () => {
        const network = new TestNetwork();
        network.dropFirstIMFromA = false;

        const kernelA = new PS2Kernel({
            nodeId: "A",
            transport: new TestTransportAdapter("A", network),
            mailboxOptions: { retryMs: 20, tickMs: 10, maxRetries: 6 },
        });
        const kernelB = new PS2Kernel({
            nodeId: "B",
            transport: new TestTransportAdapter("B", network),
            mailboxOptions: { retryMs: 20, tickMs: 10, maxRetries: 6 },
        });

        kernelA.start();
        kernelB.start();

        network.disconnect("A", "B");
        const itemId = kernelA.market.publishItem({
            title: "Offline Item",
            price: 12,
            status: "available",
        });

        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(kernelB.market.getItem(itemId)).toBeNull();

        network.connect("A", "B");
        await kernelB.market.requestSync("A");
        await waitFor(() => !!kernelB.market.getItem(itemId));
        expect(kernelB.market.getItem(itemId).title).toBe("Offline Item");
        expect(kernelB.market.getItem(itemId).price).toBe(12);

        kernelA.stop();
        kernelB.stop();
    });

    it("restores IM history after same-peer restart via sync request", async () => {
        const network = new TestNetwork();
        network.dropFirstIMFromA = false;

        const kernelA = new PS2Kernel({
            nodeId: "A",
            transport: new TestTransportAdapter("A", network),
            mailboxOptions: { retryMs: 20, tickMs: 10, maxRetries: 6 },
        });
        const kernelB = new PS2Kernel({
            nodeId: "B",
            transport: new TestTransportAdapter("B", network),
            mailboxOptions: { retryMs: 20, tickMs: 10, maxRetries: 6 },
        });

        kernelA.start();
        kernelB.start();

        await kernelA.im.sendText("B", "history-1");
        await kernelB.im.sendText("A", "history-2");
        await waitFor(() => kernelA.store.listConversation("A", "B").length >= 2);

        kernelB.stop();

        const kernelB2 = new PS2Kernel({
            nodeId: "B",
            transport: new TestTransportAdapter("B", network),
            mailboxOptions: { retryMs: 20, tickMs: 10, maxRetries: 6 },
        });
        kernelB2.start();

        expect(kernelB2.store.listConversation("A", "B").length).toBe(0);
        await kernelB2.im.requestSync("A", { limit: 50 });

        await waitFor(() => kernelB2.store.listConversation("A", "B").length >= 2);
        const texts = kernelB2.store.listConversation("A", "B").map((m) => m.text);
        expect(texts).toContain("history-1");
        expect(texts).toContain("history-2");

        kernelA.stop();
        kernelB2.stop();
    });
});
