import { describe, expect, it } from "vitest";
import { PS2Kernel } from "../src/ps2/PS2Kernel.js";
import { MeshTransportAdapter } from "../src/ps2/transport/MeshTransportAdapter.js";

class ChurnNetwork {
    constructor() {
        this.nodes = new Map(); // sessionPeerId -> mesh
        this.deliveryCounter = 0;
    }

    register(mesh) {
        this.nodes.set(mesh.sessionPeerId, mesh);
    }

    deliver(_fromSessionPeerId, targetSessionPeerId, payload) {
        const target = this.nodes.get(targetSessionPeerId);
        if (!target) return false;
        if (payload?.type !== "PS2_FRAME") return false;

        // Deterministic jitter: periodic packet loss
        this.deliveryCounter += 1;
        if (this.deliveryCounter % 5 === 0 || this.deliveryCounter % 11 === 0) {
            return false;
        }

        target.onPS2Frame?.(payload);
        return true;
    }
}

class ChurnMesh {
    constructor({ userId, sessionPeerId, network }) {
        this.userId = userId;
        this.sessionPeerId = sessionPeerId;
        this.network = network;
        this.routeMap = new Map(); // userId -> sessionPeerId
        this.dataChannels = new Map(); // sessionPeerId -> pseudo channel
        this.peerMeta = new Map(); // sessionPeerId -> { userId }
        this.onPS2Frame = null;
        network.register(this);
    }

    resolvePeerTarget(userId) {
        return this.routeMap.get(userId) || userId;
    }

    _send(targetSessionPeerId, payload) {
        return this.network.deliver(this.sessionPeerId, targetSessionPeerId, payload);
    }

    _flood(payload) {
        let sent = false;
        for (const [peerSessionId] of this.dataChannels.entries()) {
            sent = this.network.deliver(this.sessionPeerId, peerSessionId, payload) || sent;
        }
        return sent;
    }

    listActiveUsers() {
        const users = [];
        for (const [sessionPeerId] of this.dataChannels.entries()) {
            const userId = this.peerMeta.get(sessionPeerId)?.userId || null;
            if (userId) users.push(userId);
        }
        return [...new Set(users)];
    }
}

function waitFor(predicate, timeoutMs = 8000) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - startedAt > timeoutMs) return reject(new Error("waitFor timeout"));
            setTimeout(tick, 25);
        };
        tick();
    });
}

describe("PS2 churn stress", () => {
    it("keeps reliable IM delivery under route churn + deterministic packet loss", async () => {
        const network = new ChurnNetwork();

        const meshA = new ChurnMesh({ userId: "A", sessionPeerId: "sess_a_live", network });
        const meshB = new ChurnMesh({ userId: "B", sessionPeerId: "sess_b_live", network });

        meshA.dataChannels.set("sess_b_live", { readyState: "open" });
        meshA.dataChannels.set("sess_b_stale_1", { readyState: "open" });
        meshA.dataChannels.set("sess_b_stale_2", { readyState: "open" });
        meshB.dataChannels.set("sess_a_live", { readyState: "open" });

        meshA.peerMeta.set("sess_b_live", { userId: "B", peerId: "sess_b_live" });
        meshA.peerMeta.set("sess_b_stale_1", { userId: "B", peerId: "sess_b_stale_1" });
        meshA.peerMeta.set("sess_b_stale_2", { userId: "B", peerId: "sess_b_stale_2" });
        meshB.peerMeta.set("sess_a_live", { userId: "A", peerId: "sess_a_live" });

        meshA.routeMap.set("B", "sess_b_stale_1");
        meshB.routeMap.set("A", "sess_a_live");

        const adapterA = new MeshTransportAdapter(meshA);
        const adapterB = new MeshTransportAdapter(meshB);

        const kernelA = new PS2Kernel({
            nodeId: "A",
            transport: adapterA,
            mailboxOptions: {
                retryMs: 30,
                tickMs: 10,
                maxRetries: 30,
            },
        });
        const kernelB = new PS2Kernel({
            nodeId: "B",
            transport: adapterB,
            mailboxOptions: {
                retryMs: 30,
                tickMs: 10,
                maxRetries: 30,
            },
        });

        meshA.onPS2Frame = (msg) => adapterA.consumeMeshMessage(msg);
        meshB.onPS2Frame = (msg) => adapterB.consumeMeshMessage(msg);

        kernelA.start();
        kernelB.start();

        const routes = ["sess_b_stale_1", "sess_b_stale_2", "sess_b_live"];
        let idx = 0;
        const churnTimer = setInterval(() => {
            idx = (idx + 1) % routes.length;
            meshA.routeMap.set("B", routes[idx]);
        }, 35);

        const messageCount = 18;
        const sendPromises = [];
        for (let i = 1; i <= messageCount; i += 1) {
            sendPromises.push(
                kernelA.im.sendText("B", `churn-msg-${i}`, { id: `churn_msg_${i}` }),
            );
        }
        const messageIds = await Promise.all(sendPromises);

        await waitFor(() => kernelB.store.listConversation("A", "B").length >= messageCount);
        await waitFor(() => messageIds.every((id) => kernelA.store.getMessage(id)?.status === "delivered"));

        clearInterval(churnTimer);

        const convoB = kernelB.store.listConversation("A", "B");
        const receivedTexts = convoB.map((m) => m.text);
        expect(new Set(receivedTexts).size).toBe(messageCount);
        expect(receivedTexts).toContain("churn-msg-1");
        expect(receivedTexts).toContain(`churn-msg-${messageCount}`);

        kernelA.stop();
        kernelB.stop();
    });
});

