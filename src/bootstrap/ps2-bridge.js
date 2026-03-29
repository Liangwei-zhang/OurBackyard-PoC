import {
    PS2Kernel,
    MeshTransportAdapter,
    DexiePS2Store,
    InMemoryPS2Store,
} from "../ps2/index.js";
import { createWritePaths } from "./write-paths.js";

export async function bootPS2Bridge({
    mesh,
    db,
    peerId,
    userId = null,
    saveNeighborItem = null,
    autoSyncMs = 15000,
    mailboxOptions = null,
    exposeGlobal = false,
    globalScope = null,
} = {}) {
    if (!mesh) throw new Error("mesh_required");
    if (!peerId) throw new Error("peer_id_required");

    const ps2Store = (db && db.tables)
        ? new DexiePS2Store({ db })
        : new InMemoryPS2Store();
    if (ps2Store.ready && typeof ps2Store.ready.then === "function") {
        await ps2Store.ready.catch(() => {});
    }

    const ps2Adapter = new MeshTransportAdapter(mesh);
    const ps2Kernel = new PS2Kernel({
        nodeId: peerId,
        transport: ps2Adapter,
        store: ps2Store,
        autoSyncMs,
        mailboxOptions: mailboxOptions || {
            retryMs: 500,
            tickMs: 120,
            maxRetries: 5,
        },
    });
    ps2Kernel.start();

    const writePaths = createWritePaths({
        db,
        mesh,
        localUserId: userId || peerId,
        localPeerId: peerId,
        saveNeighborItem,
    });

    mesh.onPS2Frame = (msg) => ps2Adapter.consumeMeshMessage(msg);

    ps2Kernel.events.on("im:outgoing", (m) => {
        writePaths.writeChatMessage(m, {
            direction: "out",
            emitToUI: false,
        }).catch(() => {});
    });
    ps2Kernel.events.on("im:delivered", (m) => {
        writePaths.writeChatMessage(m, {
            direction: "out",
            emitToUI: false,
        }).catch(() => {});
    });
    ps2Kernel.events.on("im:incoming", (m) => {
        writePaths.writeChatMessage(m, {
            direction: "in",
            read: !!m?.readAt,
            emitToUI: true,
        }).catch(() => {});
    });
    ps2Kernel.events.on("im:read", (m) => {
        writePaths.markChatRead(m).catch(() => {});
    });

    ps2Kernel.events.on("market:item", ({ item }) => {
        writePaths.writeMarketItem(item).catch(() => {});
    });

    mesh.ps2 = ps2Kernel;
    if (exposeGlobal && globalScope) {
        globalScope.ps2 = ps2Kernel;
        globalScope.__OB_WRITE_PATHS = writePaths;
    }

    return {
        ps2Kernel,
        ps2Adapter,
        ps2Store,
        writePaths,
    };
}
