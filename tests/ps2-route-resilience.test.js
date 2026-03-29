import { describe, expect, it } from "vitest";
import { PS2Kernel } from "../src/ps2/PS2Kernel.js";
import { MeshTransportAdapter } from "../src/ps2/transport/MeshTransportAdapter.js";

class MockMeshNetwork {
    constructor() {
        this.nodes = new Map(); // sessionPeerId -> mesh
    }

    register(mesh) {
        this.nodes.set(mesh.sessionPeerId, mesh);
    }

    deliver(fromSessionPeerId, targetSessionPeerId, payload) {
        const target = this.nodes.get(targetSessionPeerId);
        if (!target) return false;
        if (payload?.type !== "PS2_FRAME") return false;
        target.onPS2Frame?.(payload);
        return true;
    }
}

class MockMesh {
    constructor({ userId, sessionPeerId, network }) {
        this.userId = userId;
        this.sessionPeerId = sessionPeerId;
        this.network = network;
        this.routeMap = new Map(); // logical userId -> sessionPeerId
        this.dataChannels = new Map(); // sessionPeerId -> pseudo channel
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
            const userId = [...this.routeMap.entries()].find(([, sid]) => sid === sessionPeerId)?.[0];
            if (userId) users.push(userId);
        }
        return [...new Set(users)];
    }
}

function waitFor(predicate, timeoutMs = 2500) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - startedAt > timeoutMs) return reject(new Error("waitFor timeout"));
            setTimeout(tick, 20);
        };
        tick();
    });
}

describe("PS2 route resilience", () => {
    it("delivers text IM with stale route map when only one direct channel is open", async () => {
        const network = new MockMeshNetwork();

        const meshA = new MockMesh({ userId: "A", sessionPeerId: "sess_a_1", network });
        const meshB = new MockMesh({ userId: "B", sessionPeerId: "sess_b_2", network });

        // Physical direct channels are open between current sessions.
        meshA.dataChannels.set("sess_b_2", { readyState: "open" });
        meshB.dataChannels.set("sess_a_1", { readyState: "open" });

        // A has stale logical route (old session that no longer exists).
        meshA.routeMap.set("B", "sess_b_1");
        // B can route ACKs back to A correctly.
        meshB.routeMap.set("A", "sess_a_1");

        const adapterA = new MeshTransportAdapter(meshA);
        const adapterB = new MeshTransportAdapter(meshB);

        const kernelA = new PS2Kernel({
            nodeId: "A",
            transport: adapterA,
            mailboxOptions: {
                retryMs: 40,
                tickMs: 10,
                maxRetries: 8,
            },
        });
        const kernelB = new PS2Kernel({
            nodeId: "B",
            transport: adapterB,
            mailboxOptions: {
                retryMs: 40,
                tickMs: 10,
                maxRetries: 8,
            },
        });

        // Wire mesh inbound frames into adapter handlers.
        meshA.onPS2Frame = (msg) => adapterA.consumeMeshMessage(msg);
        meshB.onPS2Frame = (msg) => adapterB.consumeMeshMessage(msg);

        kernelA.start();
        kernelB.start();

        const msgId = await kernelA.im.sendText("B", "route-fallback-text");

        await waitFor(() => !!kernelB.store.getMessage(msgId));
        const inbox = kernelB.store.getMessage(msgId);
        expect(inbox.text).toBe("route-fallback-text");
        expect(inbox.senderUserId).toBe("A");
        expect(inbox.recipientUserId).toBe("B");

        await waitFor(() => kernelA.store.getMessage(msgId)?.status === "delivered");
        expect(kernelA.store.getMessage(msgId).status).toBe("delivered");

        kernelA.stop();
        kernelB.stop();
    });

    it("recovers reliable delivery after route flips to a refreshed peer session", async () => {
        const network = new MockMeshNetwork();

        const meshA = new MockMesh({ userId: "A", sessionPeerId: "sess_a_1", network });
        const meshB = new MockMesh({ userId: "B", sessionPeerId: "sess_b_2", network });

        // A still keeps one stale channel entry and one current direct channel.
        meshA.dataChannels.set("sess_b_1", { readyState: "open" }); // stale, no node in network
        meshA.dataChannels.set("sess_b_2", { readyState: "open" }); // live
        meshB.dataChannels.set("sess_a_1", { readyState: "open" });

        // Initial route is stale; later it converges to refreshed session.
        meshA.routeMap.set("B", "sess_b_1");
        meshB.routeMap.set("A", "sess_a_1");

        const adapterA = new MeshTransportAdapter(meshA);
        const adapterB = new MeshTransportAdapter(meshB);

        const kernelA = new PS2Kernel({
            nodeId: "A",
            transport: adapterA,
            mailboxOptions: {
                retryMs: 40,
                tickMs: 10,
                maxRetries: 12,
            },
        });
        const kernelB = new PS2Kernel({
            nodeId: "B",
            transport: adapterB,
            mailboxOptions: {
                retryMs: 40,
                tickMs: 10,
                maxRetries: 12,
            },
        });

        meshA.onPS2Frame = (msg) => adapterA.consumeMeshMessage(msg);
        meshB.onPS2Frame = (msg) => adapterB.consumeMeshMessage(msg);

        kernelA.start();
        kernelB.start();

        setTimeout(() => {
            meshA.routeMap.set("B", "sess_b_2");
        }, 140);

        const msgId = await kernelA.im.sendText("B", "route-flip-retry");
        await waitFor(() => !!kernelB.store.getMessage(msgId));
        expect(kernelB.store.getMessage(msgId).text).toBe("route-flip-retry");

        kernelA.stop();
        kernelB.stop();
    });
});
