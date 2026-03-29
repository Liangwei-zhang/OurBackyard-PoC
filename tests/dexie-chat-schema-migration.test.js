import { describe, expect, it } from "vitest";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";

describe("dexie chat schema migration", () => {
    it("migrates legacy chat rows into chatMessagesV2", async () => {
        Dexie.dependencies.indexedDB = indexedDB;
        Dexie.dependencies.IDBKeyRange = IDBKeyRange;

        const dbName = `ob_chat_schema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const dbV5 = new Dexie(dbName);
        dbV5.version(5).stores({
            chatMessages: "++id, from, to, ts, itemId, direction, read",
            items: "++id",
            blobs: "++id, hash",
            sync: "++id, type",
            userData: "key",
            secureData: "key",
            systemAssets: "url, hash, version",
            blocklist: "itemHash, reason, timestamp",
            deadDrop: "++id, toPeerId, createdAt, delivered",
        });
        await dbV5.open();
        await dbV5.chatMessages.add({
            from: "peer_a",
            to: "peer_b",
            ts: Date.now(),
            direction: "out",
            text: "legacy row",
        });
        await dbV5.close();

        const dbV6 = new Dexie(dbName);
        dbV6.version(5).stores({
            chatMessages: "++id, from, to, ts, itemId, direction, read",
            items: "++id",
            blobs: "++id, hash",
            sync: "++id, type",
            userData: "key",
            secureData: "key",
            systemAssets: "url, hash, version",
            blocklist: "itemHash, reason, timestamp",
            deadDrop: "++id, toPeerId, createdAt, delivered",
        });
        dbV6.version(6).stores({
            chatMessages: "++id, from, to, ts, itemId, direction, read",
            chatMessagesV2: "id, from, to, senderUserId, recipientUserId, ts, itemId, direction, read",
            items: "++id",
            blobs: "++id, hash",
            sync: "++id, type",
            userData: "key",
            secureData: "key",
            systemAssets: "url, hash, version",
            blocklist: "itemHash, reason, timestamp",
            deadDrop: "++id, toPeerId, createdAt, delivered",
        }).upgrade(async (tx) => {
            const rows = await tx.table("chatMessages").toArray().catch(() => []);
            let seq = 0;
            for (const row of rows) {
                const from = row.senderUserId || row.from || null;
                const to = row.recipientUserId || row.to || null;
                const ts = Number(row.ts || row.timestamp || Date.now());
                const id = `legacy_${ts}_${seq++}`;
                await tx.table("chatMessagesV2").put({
                    ...row,
                    id,
                    from,
                    to,
                    senderUserId: from,
                    recipientUserId: to,
                    ts,
                });
            }
        });

        await dbV6.open();
        const migratedRows = await dbV6.chatMessagesV2.toArray();
        expect(migratedRows.length).toBe(1);
        expect(migratedRows[0].text).toBe("legacy row");

        await dbV6.chatMessagesV2.put({
            id: "msg_1",
            from: "peer_a",
            to: "peer_b",
            ts: Date.now(),
            direction: "out",
            text: "new row",
        });
        const row = await dbV6.chatMessagesV2.get("msg_1");
        expect(row?.text).toBe("new row");

        await dbV6.delete();
    });
});
