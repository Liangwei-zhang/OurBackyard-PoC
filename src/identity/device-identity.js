function toFixedNumber(value, digits = 2) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return "0";
    return String(Number(num.toFixed(digits)));
}

function stableString(value) {
    if (value == null) return "";
    return String(value).trim();
}

function stableList(list) {
    if (!Array.isArray(list) || list.length === 0) return "";
    return [...new Set(list.map((v) => stableString(v).toLowerCase()).filter(Boolean))].sort().join(",");
}

function randomId(prefix = "peer") {
    return `${prefix}_${Math.random().toString(36).slice(2, 13)}`;
}

function computeItemKey(item, ownerUserId) {
    const owner = stableString(ownerUserId || item?.ownerUserId || item?.sellerId || "");
    const rawId = item?.itemId ?? item?.originalId ?? item?.id ?? null;
    if (!owner || rawId == null) return "";
    const id = String(rawId);
    if (id.includes(":")) return id;
    return `${owner}:${id}`;
}

async function detectWebGLRenderer() {
    try {
        if (typeof document === "undefined") return "";
        const canvas = document.createElement("canvas");
        const gl =
            canvas.getContext("webgl") ||
            canvas.getContext("experimental-webgl");
        if (!gl) return "";
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (!ext) return "";
        return stableString(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    } catch {
        return "";
    }
}

export async function collectDeviceSignals(runtime = {}) {
    const nav = runtime.navigator || globalThis.navigator || {};
    const scr = runtime.screen || globalThis.screen || {};
    const intl = runtime.Intl || globalThis.Intl;

    let tz = "";
    try {
        tz = stableString(intl?.DateTimeFormat?.().resolvedOptions?.().timeZone);
    } catch {
        tz = "";
    }

    const webglRenderer =
        runtime.webglRenderer !== undefined
            ? stableString(runtime.webglRenderer)
            : await detectWebGLRenderer();

    return {
        platform: stableString(nav.platform),
        architecture: stableString(nav.userAgentData?.architecture),
        hardwareConcurrency: stableString(nav.hardwareConcurrency || 0),
        deviceMemory: stableString(nav.deviceMemory || 0),
        maxTouchPoints: stableString(nav.maxTouchPoints || 0),
        language: stableString(nav.language || ""),
        languages: stableList(nav.languages || []),
        timezone: tz,
        timezoneOffset: stableString(new Date().getTimezoneOffset()),
        screen: `${stableString(scr.width || 0)}x${stableString(scr.height || 0)}x${stableString(scr.colorDepth || 0)}`,
        pixelRatio: toFixedNumber(runtime.devicePixelRatio || globalThis.devicePixelRatio || 1),
        webglRenderer,
    };
}

export function serializeSignals(signals = {}) {
    const ordered = [
        ["platform", signals.platform],
        ["architecture", signals.architecture],
        ["hardwareConcurrency", signals.hardwareConcurrency],
        ["deviceMemory", signals.deviceMemory],
        ["maxTouchPoints", signals.maxTouchPoints],
        ["language", signals.language],
        ["languages", signals.languages],
        ["timezone", signals.timezone],
        ["timezoneOffset", signals.timezoneOffset],
        ["screen", signals.screen],
        ["pixelRatio", signals.pixelRatio],
        ["webglRenderer", signals.webglRenderer],
    ];
    return ordered.map(([k, v]) => `${k}=${stableString(v)}`).join("|");
}

export async function sha256Hex(input) {
    const text = stableString(input);
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        let out = "";
        for (let i = 0; i < text.length; i += 1) {
            out += text.charCodeAt(i).toString(16).padStart(2, "0");
        }
        return out.padEnd(64, "0").slice(0, 64);
    }
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deriveCanonicalPeerId({
    namespace = "ourbackyard",
    runtime = {},
} = {}) {
    const signals = await collectDeviceSignals(runtime);
    const payload = `${namespace}|${serializeSignals(signals)}`;
    const hashHex = await sha256Hex(payload);
    return {
        hashHex,
        signals,
        canonicalPeerId: `peer_${hashHex.slice(0, 20)}`,
    };
}

async function migratePeerData(db, fromPeerId, toPeerId) {
    if (!db || !fromPeerId || !toPeerId || fromPeerId === toPeerId) return;

    const itemTable = db.items;
    if (itemTable?.where) {
        await itemTable.where("sellerId").equals(fromPeerId).modify((item) => {
            item.sellerId = toPeerId;
            if (!item.ownerUserId || item.ownerUserId === fromPeerId) {
                item.ownerUserId = toPeerId;
            }
            const itemKey = computeItemKey(item, item.ownerUserId || toPeerId);
            if (itemKey) item.itemKey = itemKey;
            item.updatedAt = Date.now();
        }).catch(() => {});
        await itemTable.where("ownerUserId").equals(fromPeerId).modify((item) => {
            item.ownerUserId = toPeerId;
            if (!item.sellerId) item.sellerId = toPeerId;
            const itemKey = computeItemKey(item, toPeerId);
            if (itemKey) item.itemKey = itemKey;
            item.updatedAt = Date.now();
        }).catch(() => {});
    }

    const msgTables = [db.chatMessagesV2, db.chatMessages].filter((t) => t?.toCollection);
    for (const msgTable of msgTables) {
        await msgTable.toCollection().modify((msg) => {
            if (msg.from === fromPeerId) msg.from = toPeerId;
            if (msg.to === fromPeerId) msg.to = toPeerId;
            if (msg.senderUserId === fromPeerId) msg.senderUserId = toPeerId;
            if (msg.recipientUserId === fromPeerId) msg.recipientUserId = toPeerId;
        }).catch(() => {});
    }

    const deadDropTable = db.deadDrop;
    if (deadDropTable?.toCollection) {
        await deadDropTable.toCollection().modify((row) => {
            if (row.toUserId === fromPeerId) row.toUserId = toPeerId;
            if (row.msg?.from === fromPeerId) row.msg.from = toPeerId;
            if (row.msg?.to === fromPeerId) row.msg.to = toPeerId;
            if (row.msg?.senderUserId === fromPeerId) row.msg.senderUserId = toPeerId;
            if (row.msg?.recipientUserId === fromPeerId) row.msg.recipientUserId = toPeerId;
        }).catch(() => {});
    }
}

async function appendAlias(db, oldPeerId, newPeerId) {
    if (!db || !oldPeerId || !newPeerId || oldPeerId === newPeerId) return;
    const key = `identity_alias_${oldPeerId}`;
    await db.userData?.put?.({
        key,
        value: newPeerId,
        ts: Date.now(),
    }).catch(() => {});
}

export async function ensureCanonicalIdentity({
    db = null,
    storage = globalThis.localStorage,
    userStorageKey = "ourbackyard_userId",
    sessionStorageKey = "ourbackyard_session_peerId",
    peerStorageKey = "ourbackyard_peerId",
    namespace = "ourbackyard",
    runtime = {},
} = {}) {
    const previousUserId = stableString(
        storage?.getItem?.(userStorageKey) ||
        storage?.getItem?.(peerStorageKey) ||
        "",
    );

    let canonicalFromDb = "";
    try {
        canonicalFromDb = stableString(
            (await db?.userData?.get?.("identity_canonical_user"))?.value ||
            (await db?.userData?.get?.("identity_canonical_peer"))?.value ||
            "",
        );
    } catch {
        canonicalFromDb = "";
    }

    let derived = null;
    try {
        derived = await deriveCanonicalPeerId({ namespace, runtime });
    } catch {
        derived = null;
    }

    const nextUserId =
        canonicalFromDb ||
        derived?.canonicalPeerId ||
        previousUserId ||
        randomId("peer");

    const existingSessionPeerId = stableString(storage?.getItem?.(sessionStorageKey) || "");
    const sessionPeerId = existingSessionPeerId || randomId("peer_sess");
    if (storage?.setItem) {
        storage.setItem(userStorageKey, nextUserId);
        // Keep legacy key in sync for backwards compatibility with existing modules.
        storage.setItem(peerStorageKey, nextUserId);
        storage.setItem(sessionStorageKey, sessionPeerId);
    }

    await db?.userData?.put?.({
        key: "identity_canonical_user",
        value: nextUserId,
        ts: Date.now(),
    }).catch(() => {});

    await db?.userData?.put?.({
        key: "identity_canonical_peer",
        value: nextUserId,
        ts: Date.now(),
    }).catch(() => {});

    await db?.userData?.put?.({
        key: "identity_session_peer",
        value: sessionPeerId,
        ts: Date.now(),
    }).catch(() => {});

    if (derived?.hashHex) {
        await db?.userData?.put?.({
            key: "identity_device_hash",
            value: derived.hashHex,
            ts: Date.now(),
        }).catch(() => {});
    }

    if (previousUserId && previousUserId !== nextUserId) {
        await migratePeerData(db, previousUserId, nextUserId);
        await appendAlias(db, previousUserId, nextUserId);
    }

    return {
        // Backward compatibility: peerId continues to represent the stable user id.
        peerId: nextUserId,
        userId: nextUserId,
        sessionPeerId,
        previousPeerId: previousUserId || null,
        previousUserId: previousUserId || null,
        changed: !!previousUserId && previousUserId !== nextUserId,
        deviceHash: derived?.hashHex || null,
        signals: derived?.signals || null,
    };
}
