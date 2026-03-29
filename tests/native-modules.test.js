import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class WorkerMock {
    constructor() {
        this.onmessage = null;
    }

    postMessage(message) {
        const { type, data } = message;
        setTimeout(() => {
            if (!this.onmessage) return;
            if (type === "init") {
                this.onmessage({ data: { type: "ready", peerId: data.peerId } });
                return;
            }
            if (type === "send") {
                this.onmessage({
                    data: {
                        type: "sent",
                        targetPeerId: data.targetPeerId,
                        messageId: data.message.id,
                    },
                });
                return;
            }
            if (type === "broadcast") {
                this.onmessage({
                    data: {
                        type: "broadcasted",
                        topic: data.topic,
                        messageId: data.message.id,
                    },
                });
                return;
            }
            if (type === "sync") {
                const missing = data.remoteHashes.filter((h) => !data.localHashes.includes(h));
                this.onmessage({ data: { type: "sync_result", requestId: data.requestId, missing } });
                return;
            }
            if (type === "compute") {
                this.onmessage({
                    data: {
                        type: "compute_result",
                        requestId: data.requestId,
                        operation: data.operation,
                        result: `mock-${data.operation}`,
                    },
                });
            }
        }, 0);
    }

    terminate() {}
}

describe("native modules", () => {
    beforeAll(async () => {
        await __loadScript("native/resource-quota.js");
        await __loadScript("native/ai/local-ai.js");
        await __loadScript("native/governance/wot-trust.js");
        await __loadScript("native/desktop-full-node.js");
        await __loadScript("native/data/sponsor-node.js");
        await __loadScript("native/data/geo-prefetch.js");
        await __loadScript("native/governance/pow-spam-protection.js");
        await __loadScript("native/governance/dao-governance.js");
        await __loadScript("native/governance/zk-reputation-complete.js");
        await __loadScript("native/security/key-vault.js");
        await __loadScript("native/security/geo-consent.js");
        await __loadScript("native/p2p-worker.js");
    });

    beforeEach(() => {
        __resetDom();
        vi.restoreAllMocks();
    });

    it("resource quota tracks usage and contribution", async () => {
        await window.ResourceQuota.recordContribution("peer-1", "storage", 2);
        await window.ResourceQuota.recordContribution("peer-1", "bandwidth", 1);
        const quota = await window.ResourceQuota.getQuota("peer-1");
        expect(quota.messagesPerHour).toBeGreaterThan(100);

        await window.ResourceQuota.recordAction("peer-1", "broadcast");
        const usage = await window.ResourceQuota.getUsage("peer-1", "broadcast");
        expect(usage).toBe(1);
    });

    it("local AI can index and search", async () => {
        await window.LocalAI.init();
        await window.LocalAI.indexItem({ id: "i1", title: "Mountain bike", description: "Blue bike", category: "Sports", condition: "used" });
        await window.LocalAI.indexItem({ id: "i2", title: "Coffee mug", description: "Ceramic", category: "Kitchen", condition: "new" });

        const results = await window.LocalAI.search("bike", 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].itemId).toBe("i1");
    });

    it("web of trust computes trust decisions", () => {
        window.WebOfTrust.init("me");
        window.WebOfTrust.trust("peer-a", "TRUSTED");
        window.WebOfTrust.block("peer-b");

        expect(window.WebOfTrust.getTrustScore("peer-a")).toBeGreaterThan(0.7);
        const blocked = window.WebOfTrust.shouldDisplay("peer-b", "x");
        expect(blocked.display).toBe(false);
    });

    it("desktop full node can start and stop in capability mode", async () => {
        Object.defineProperty(navigator, "deviceMemory", { value: 16, configurable: true });
        Object.defineProperty(navigator, "hardwareConcurrency", { value: 8, configurable: true });
        navigator.storage = {
            estimate: async () => ({ quota: 60 * 1024 * 1024 * 1024, usage: 10 * 1024 * 1024 * 1024 }),
        };

        const result = await window.DesktopFullNode.start("peer-d", "h3", {
            enableDataProxy: false,
            enable24hSync: false,
            enableLLMFilter: false,
        });
        expect(result.success).toBe(true);
        expect(window.DesktopFullNode.isRunning).toBe(true);
        await window.DesktopFullNode.stop();
        expect(window.DesktopFullNode.isRunning).toBe(false);
    });

    it("sponsor node stores and retrieves mirrored data", async () => {
        await window.SponsorNode.init("peer-owner");
        const stored = await window.SponsorNode.storeWithMirrors({ title: "Item" }, "item-1");
        expect(stored.local).toBe(true);

        await window.SponsorNode.handleMirrorRequest("peer-a", {
            itemId: "item-2",
            data: { title: "From peer" },
            timestamp: Date.now(),
        });

        const restored = await window.SponsorNode.retrieveMirrored("item-2");
        expect(restored[0].title).toBe("From peer");
        window.SponsorNode.stop();
    });

    it("geo prefetch records and predicts locations", () => {
        window.GeoPrefetch.history = [];
        for (let i = 0; i < 8; i++) {
            window.GeoPrefetch.recordLocation("h3-a");
        }
        for (let i = 0; i < 2; i++) {
            window.GeoPrefetch.recordLocation("h3-b");
        }

        const preds = window.GeoPrefetch.predictNextLocations();
        expect(preds.length).toBeGreaterThan(0);
        const neighbors = window.GeoPrefetch.getNeighborsForPrefetch("h3-a");
        expect(neighbors[0]).toBe("h3-a");
        expect(neighbors.length).toBeGreaterThan(1);
    });

    it("pow spam protection computes and verifies proof", async () => {
        window.PoWSpamProtection.config.difficulty = 10;
        window.PoWSpamProtection.config.maxDelay = 2000;
        const proof = await window.PoWSpamProtection.compute("target-1");
        expect(proof.nonce).toBeGreaterThanOrEqual(0);
        expect(await window.PoWSpamProtection.verify("target-1", proof, { difficulty: 10 })).toBe(true);
    });

    it("dao governance can submit and resolve a proposal", async () => {
        await window.DAOGovernance.init();
        window.DAOGovernance.config.quorum = 1;
        window.DAOGovernance.config.voteThreshold = 0.5;

        const submitted = await window.DAOGovernance.submitForReview({ text: "report this" }, "did:me");
        const proposal = submitted.proposal;
        expect(proposal.id).toBeTruthy();

        const voteResult = await window.DAOGovernance.vote(proposal.id, "did:voter1", "remove");
        expect(voteResult.voteRecorded).toBe(true);

        const stats = await window.DAOGovernance.getStats();
        expect(stats.proposals).toBeGreaterThanOrEqual(1);
        expect(stats.votes).toBeGreaterThanOrEqual(1);
    });

    it("zk reputation system updates points and creates threshold proofs", async () => {
        await window.ZKReputationSystem.init("peer-zk");
        await window.ZKReputationSystem.awardPoints(20, "helpful");
        expect(window.ZKReputationSystem.reputation.points).toBeGreaterThanOrEqual(30);

        const proof = await window.ZKReputationSystem.proveThreshold(20);
        expect(proof.valid).toBe(true);

        const verify = await window.ZKReputationSystem.verifyThresholdProof(proof);
        expect(typeof verify.valid).toBe("boolean");
    });

    it("p2p worker promises resolve for init/send/broadcast/sync/compute", async () => {
        globalThis.Worker = WorkerMock;
        const worker = await window.P2PWorker.init("peer-w");
        expect(worker.isReady()).toBe(true);

        const sendResult = await worker.sendToPeer("peer-x", { payload: "a" });
        expect(sendResult.success).toBe(true);

        const broadcastResult = await worker.broadcast("topic-1", { payload: "b" });
        expect(broadcastResult.success).toBe(true);

        const missing = await worker.sync(["a"], ["a", "b"]);
        expect(missing).toEqual(["b"]);

        const compute = await worker.computeHash({ x: 1 });
        expect(compute).toBe("mock-hash");

        worker.terminate();
        expect(worker.isReady()).toBe(false);
    });

    it("security modules are exported to window for runtime access", () => {
        expect(window.KeyVault).toBeTruthy();
        expect(window.VaultUI).toBeTruthy();
        expect(window.GeoConsent).toBeTruthy();
    });
});

