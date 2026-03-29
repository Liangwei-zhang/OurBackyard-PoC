import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { DexiePS2Store } from "../src/ps2/store/DexiePS2Store.js";

async function waitForAsync(predicate, timeoutMs = 1200) {
    const started = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (await predicate()) return;
        if (Date.now() - started > timeoutMs) {
            throw new Error("waitForAsync timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const openedDbs = [];

async function makeDb(name) {
    const db = new Dexie(name);
    db.version(1).stores({
        chatMessages: "id, from, to, ts, itemId, direction, read",
        items: "id, status, updatedAt, _clock, _opId",
        sync: "++id, type, opId",
    });
    await db.open();
    openedDbs.push(db);
    return db;
}

afterEach(async () => {
    while (openedDbs.length > 0) {
        const db = openedDbs.pop();
        const name = db.name;
        db.close();
        await Dexie.delete(name);
    }
});

describe("DexiePS2Store", () => {
    it("persists chat messages and patches status", async () => {
        const db = await makeDb("ps2-store-msg");
        const store = new DexiePS2Store({ db });
        await store.ready;

        store.saveMessage({
            id: "m1",
            from: "A",
            to: "B",
            ts: Date.now(),
            text: "hello",
            direction: "out",
            status: "sending",
        });
        store.patchMessage("m1", { status: "delivered" });

        await waitForAsync(async () => {
            const row = await db.chatMessages.get("m1");
            return row?.status === "delivered";
        });

        expect(store.getMessage("m1")?.status).toBe("delivered");
    });

    it("applies LWW item updates and restores market op dedupe after restart", async () => {
        const db = await makeDb("ps2-store-items");
        const store = new DexiePS2Store({ db });
        await store.ready;

        expect(
            store.upsertItem({
                id: "item-1",
                title: "first",
                _clock: 1,
                _opId: "op-1",
            }),
        ).toBe(true);

        expect(
            store.upsertItem({
                id: "item-1",
                title: "stale",
                _clock: 0,
                _opId: "op-0",
            }),
        ).toBe(false);

        expect(
            store.upsertItem({
                id: "item-1",
                title: "latest",
                _clock: 2,
                _opId: "op-2",
            }),
        ).toBe(true);

        store.markMarketOp("op-2");

        await waitForAsync(async () => {
            const item = await db.items.get("item-1");
            const ops = await db.sync.where("type").equals("ps2.market.op").toArray();
            return item?.title === "latest" && ops.some((op) => op.opId === "op-2");
        });

        const restored = new DexiePS2Store({ db });
        await restored.ready;

        expect(restored.getItem("item-1")?.title).toBe("latest");
        expect(restored.hasMarketOp("op-2")).toBe(true);
    });
});
