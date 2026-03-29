import { describe, expect, it } from "vitest";
import {
    deriveCanonicalPeerId,
    ensureCanonicalIdentity,
    serializeSignals,
} from "../src/identity/device-identity.js";

function makeRuntime() {
    return {
        navigator: {
            platform: "Win32",
            userAgentData: { architecture: "x86" },
            hardwareConcurrency: 8,
            deviceMemory: 16,
            maxTouchPoints: 0,
            language: "zh-CN",
            languages: ["zh-CN", "en-US"],
        },
        screen: {
            width: 1920,
            height: 1080,
            colorDepth: 24,
        },
        Intl,
        devicePixelRatio: 1.25,
        webglRenderer: "ANGLE (NVIDIA GeForce RTX 3060)",
    };
}

function makeStorage(seed = {}) {
    const bag = new Map(Object.entries(seed));
    return {
        getItem(key) {
            return bag.has(key) ? bag.get(key) : null;
        },
        setItem(key, value) {
            bag.set(key, String(value));
        },
        _dump() {
            return bag;
        },
    };
}

function makeDb(items = [], messages = [], deadDrops = []) {
    const userData = new Map();

    return {
        userData: {
            async get(key) {
                return userData.get(key) || null;
            },
            async put(row) {
                userData.set(row.key, { ...row });
            },
            _map: userData,
        },
        items,
        chatMessages: messages,
        itemsTable: {
            where(field) {
                return {
                    equals(value) {
                        return {
                            async modify(mutator) {
                                items.forEach((item) => {
                                    if (item[field] === value) mutator(item);
                                });
                            },
                        };
                    },
                };
            },
        },
        chatTable: {
            toCollection() {
                return {
                    async modify(mutator) {
                        messages.forEach((msg) => mutator(msg));
                    },
                };
            },
        },
        deadDropTable: {
            toCollection() {
                return {
                    async modify(mutator) {
                        deadDrops.forEach((row) => mutator(row));
                    },
                };
            },
        },
        get itemsProxy() {
            return this.itemsTable;
        },
        get chatProxy() {
            return this.chatTable;
        },
        get deadDropProxy() {
            return this.deadDropTable;
        },
    };
}

function attachDbTables(db) {
    db.items = db.itemsProxy;
    db.chatMessages = db.chatProxy;
    db.deadDrop = db.deadDropProxy;
    return db;
}

describe("device identity", () => {
    it("derives deterministic canonical peer id from the same device signals", async () => {
        const runtime = makeRuntime();
        const first = await deriveCanonicalPeerId({ namespace: "ourbackyard", runtime });
        const second = await deriveCanonicalPeerId({ namespace: "ourbackyard", runtime });

        expect(first.canonicalPeerId).toBe(second.canonicalPeerId);
        expect(first.hashHex).toBe(second.hashHex);
        expect(first.canonicalPeerId.startsWith("peer_")).toBe(true);
        expect(serializeSignals(first.signals)).toContain("platform=Win32");
    });

    it("normalizes legacy peer id and migrates local ownership records", async () => {
        const runtime = makeRuntime();
        const derived = await deriveCanonicalPeerId({ namespace: "ourbackyard", runtime });
        const oldPeerId = "peer_legacy_abc";
        const storage = makeStorage({ ourbackyard_peerId: oldPeerId });

        const itemRows = [{ id: 1, sellerId: oldPeerId, ownerUserId: oldPeerId, title: "Bike" }];
        const msgRows = [{
            id: "m1",
            from: oldPeerId,
            to: "peer_x",
            senderUserId: oldPeerId,
            recipientUserId: "peer_x",
        }];
        const deadDropRows = [{
            id: "dd1",
            toUserId: oldPeerId,
            msg: {
                from: oldPeerId,
                to: "peer_x",
                senderUserId: oldPeerId,
                recipientUserId: "peer_x",
            },
        }];
        const db = attachDbTables(makeDb(itemRows, msgRows, deadDropRows));

        const result = await ensureCanonicalIdentity({
            db,
            storage,
            namespace: "ourbackyard",
            runtime,
        });

        expect(result.peerId).toBe(derived.canonicalPeerId);
        expect(result.userId).toBe(derived.canonicalPeerId);
        expect(result.sessionPeerId.startsWith("peer_sess_")).toBe(true);
        expect(result.changed).toBe(true);
        expect(storage.getItem("ourbackyard_peerId")).toBe(derived.canonicalPeerId);
        expect(storage.getItem("ourbackyard_userId")).toBe(derived.canonicalPeerId);
        expect(storage.getItem("ourbackyard_session_peerId")).toBe(result.sessionPeerId);
        expect(itemRows[0].sellerId).toBe(derived.canonicalPeerId);
        expect(itemRows[0].ownerUserId).toBe(derived.canonicalPeerId);
        expect(msgRows[0].from).toBe(derived.canonicalPeerId);
        expect(msgRows[0].senderUserId).toBe(derived.canonicalPeerId);
        expect(deadDropRows[0].toUserId).toBe(derived.canonicalPeerId);
        expect(deadDropRows[0].msg.from).toBe(derived.canonicalPeerId);
        expect(deadDropRows[0].msg.senderUserId).toBe(derived.canonicalPeerId);
    });

    it("reuses previously stored canonical peer id from db", async () => {
        const runtime = makeRuntime();
        const storage = makeStorage();
        const db = attachDbTables(makeDb([], []));
        await db.userData.put({ key: "identity_canonical_peer", value: "peer_existing_fixed" });

        const result = await ensureCanonicalIdentity({
            db,
            storage,
            namespace: "ourbackyard",
            runtime,
        });

        expect(result.peerId).toBe("peer_existing_fixed");
        expect(result.userId).toBe("peer_existing_fixed");
        expect(storage.getItem("ourbackyard_peerId")).toBe("peer_existing_fixed");
        expect(storage.getItem("ourbackyard_userId")).toBe("peer_existing_fixed");
        expect(storage.getItem("ourbackyard_session_peerId")).toBe(result.sessionPeerId);
    });

    it("keeps an existing session peer id stable across runs", async () => {
        const runtime = makeRuntime();
        const storage = makeStorage({
            ourbackyard_userId: "peer_user_fixed",
            ourbackyard_session_peerId: "peer_sess_browser_a",
        });
        const db = attachDbTables(makeDb([], []));

        const first = await ensureCanonicalIdentity({
            db,
            storage,
            namespace: "ourbackyard",
            runtime,
        });
        const second = await ensureCanonicalIdentity({
            db,
            storage,
            namespace: "ourbackyard",
            runtime,
        });

        expect(first.userId).toBe(second.userId);
        expect(first.sessionPeerId).toBe("peer_sess_browser_a");
        expect(second.sessionPeerId).toBe("peer_sess_browser_a");
    });
});
