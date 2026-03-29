import { normalizePS2UIChatEvent } from "../contracts/ps2-ui-contract.js";

export const DEFAULT_COMMUNITY_STORE_KEY = "community_channel_msgs_v2";
export const DEFAULT_COMMUNITY_MAX_MESSAGES = 400;

function _trimString(value, maxLen) {
    return String(value ?? "").slice(0, maxLen);
}

function _safeTs(value, now = Date.now()) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : now;
}

function _simpleHash(input) {
    const text = String(input ?? "");
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h +=
            (h << 1) +
            (h << 4) +
            (h << 7) +
            (h << 8) +
            (h << 24);
    }
    return (h >>> 0).toString(16);
}

export function getChatTable(dbRef) {
    return dbRef?.chatMessagesV2 || dbRef?.chatMessages || null;
}

export function normalizeMarketItemEvent(item, { now = () => Date.now() } = {}) {
    if (!item || typeof item !== "object") return null;
    const imageHashes = Array.isArray(item.imageHashes)
        ? item.imageHashes.filter(Boolean)
        : (item.imageHash ? [item.imageHash] : []);
    const normalized = {
        ...item,
        id: item.itemId || item.id,
        ownerUserId: item.ownerUserId || item.sellerId || null,
        sellerId: item.sellerId || item.ownerUserId || null,
        updatedAt: item.updatedAt || item.ts || now(),
        timestamp: item.timestamp || item.ts || item.updatedAt || now(),
        imageHashes,
    };
    if (!normalized.imageHash && normalized.imageHashes.length > 0) {
        normalized.imageHash = normalized.imageHashes[0];
    }
    return normalized;
}

export async function writeMarketItem({
    item,
    saveNeighborItem,
}) {
    const normalized = normalizeMarketItemEvent(item);
    if (!normalized) return { ok: false, reason: "invalid_item" };
    if (typeof saveNeighborItem !== "function") {
        return { ok: false, reason: "missing_save_handler", item: normalized };
    }
    await saveNeighborItem(normalized);
    return { ok: true, item: normalized };
}

export async function writeChatMessage({
    db,
    mesh,
    message,
    direction = null,
    localUserId = null,
    localPeerId = null,
    read = false,
    emitToUI = false,
}) {
    const normalized = normalizePS2UIChatEvent(message, {
        direction,
        localUserId,
        localPeerId,
    });
    if (!normalized) return { ok: false, reason: "invalid_chat_message" };

    const chatTable = getChatTable(db);
    if (!chatTable) return { ok: false, reason: "chat_table_missing" };

    const row = {
        ...normalized,
        direction: normalized.direction || direction || null,
        read: !!read || !!message?.readAt,
    };
    await chatTable.put(row).catch(() => {});
    if (emitToUI && typeof mesh?.onChat === "function") {
        try {
            mesh.onChat({ ...row });
        } catch (_) {}
    }
    return { ok: true, row };
}

export async function markChatRead({
    db,
    mesh,
    message,
}) {
    const chatTable = getChatTable(db);
    if (!chatTable) return { ok: false, reason: "chat_table_missing" };
    const msgId = message?.id || message?.msgId || null;
    if (!msgId) return { ok: false, reason: "missing_msg_id" };

    const existing = await chatTable.where("id").equals(String(msgId)).first().catch(() => null);
    const row = {
        ...(existing || message || {}),
        id: String(msgId),
        read: true,
        readAt: Number(message?.readAt || message?.ts || Date.now()),
    };
    await chatTable.put(row).catch(() => {});

    if (typeof mesh?.onChat === "function") {
        try {
            mesh.onChat({
                type: "read",
                msgId: String(msgId),
                from: message?.to || message?.from || row.to || row.from || null,
            });
        } catch (_) {}
    }
    return { ok: true, row };
}

export function normalizeCommunityMessage(
    message,
    {
        fallbackChannel = "general",
        localPeerId = null,
        localName = null,
        now = () => Date.now(),
    } = {},
) {
    if (!message || typeof message !== "object") return null;
    const channel = _trimString(message.channel || fallbackChannel, 40) || "general";
    const from = _trimString(message.from || localPeerId || "peer_unknown", 80);
    const name = _trimString(
        message.name || localName || (from ? from.slice(0, 8) : "unknown"),
        40,
    );
    const text = _trimString(message.text || "", 2000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
    if (!text) return null;
    const ts = _safeTs(message.ts, now());
    const id = _trimString(
        message.id || `ch_${_simpleHash(`${channel}|${from}|${ts}|${text}`)}`,
        96,
    );
    return {
        type: "CHANNEL_MSG",
        id,
        channel,
        from,
        name,
        text,
        ts,
    };
}

function _communityMessageSignature(msg) {
    return `${msg.from || ""}|${msg.ts || 0}|${msg.text || ""}`;
}

export function mergeCommunityMessage(
    channelState,
    message,
    {
        maxPerChannel = DEFAULT_COMMUNITY_MAX_MESSAGES,
        fallbackChannel = "general",
        localPeerId = null,
        localName = null,
    } = {},
) {
    if (!channelState || typeof channelState !== "object") {
        return { added: false, message: null };
    }
    const normalized = normalizeCommunityMessage(message, {
        fallbackChannel,
        localPeerId,
        localName,
    });
    if (!normalized) return { added: false, message: null };

    const channel = normalized.channel;
    if (!Array.isArray(channelState[channel])) {
        channelState[channel] = [];
    }
    const arr = channelState[channel];
    const exists = arr.some((m) =>
        (m?.id && normalized.id && String(m.id) === String(normalized.id)) ||
        _communityMessageSignature(m || {}) === _communityMessageSignature(normalized),
    );
    if (exists) return { added: false, message: normalized };

    arr.push(normalized);
    arr.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
    if (arr.length > maxPerChannel) {
        arr.splice(0, arr.length - maxPerChannel);
    }
    return { added: true, message: normalized };
}

export function snapshotCommunityState(
    channelState,
    {
        channels = [],
        maxPerChannel = DEFAULT_COMMUNITY_MAX_MESSAGES,
    } = {},
) {
    const out = {};
    const channelIds = Array.isArray(channels) && channels.length > 0
        ? channels.map((c) => (typeof c === "string" ? c : c?.id)).filter(Boolean)
        : Object.keys(channelState || {});
    for (const channel of channelIds) {
        out[channel] = [];
        const arr = Array.isArray(channelState?.[channel]) ? channelState[channel] : [];
        for (const m of arr) {
            mergeCommunityMessage(out, { ...m, channel }, { maxPerChannel, fallbackChannel: channel });
        }
    }
    return out;
}

export async function loadCommunitySnapshot({
    db,
    channels = [],
    storeKey = DEFAULT_COMMUNITY_STORE_KEY,
    maxPerChannel = DEFAULT_COMMUNITY_MAX_MESSAGES,
}) {
    const out = {};
    const channelIds = Array.isArray(channels) && channels.length > 0
        ? channels.map((c) => (typeof c === "string" ? c : c?.id)).filter(Boolean)
        : [];
    channelIds.forEach((id) => { out[id] = []; });
    if (!db?.userData) return out;

    const rec = await db.userData.get(storeKey).catch(() => null);
    const val = rec?.value;
    if (!val || typeof val !== "object") return out;

    const ids = channelIds.length > 0
        ? channelIds
        : Object.keys(val);
    ids.forEach((id) => { if (!Array.isArray(out[id])) out[id] = []; });

    for (const channel of ids) {
        const arr = Array.isArray(val[channel]) ? val[channel] : [];
        for (const m of arr) {
            mergeCommunityMessage(out, { ...m, channel }, { maxPerChannel, fallbackChannel: channel });
        }
    }
    return out;
}

export async function persistCommunitySnapshot({
    db,
    channelState,
    channels = [],
    storeKey = DEFAULT_COMMUNITY_STORE_KEY,
    maxPerChannel = DEFAULT_COMMUNITY_MAX_MESSAGES,
}) {
    if (!db?.userData) return false;
    const snapshot = snapshotCommunityState(channelState, {
        channels,
        maxPerChannel,
    });
    await db.userData.put({
        key: storeKey,
        value: snapshot,
        updatedAt: Date.now(),
    }).catch(() => {});
    return true;
}

export function createWritePaths({
    db = null,
    mesh = null,
    localUserId = null,
    localPeerId = null,
    saveNeighborItem = null,
} = {}) {
    return {
        getChatTable(dbRef = db) {
            return getChatTable(dbRef);
        },

        writeChatMessage(message, options = {}) {
            return writeChatMessage({
                db,
                mesh,
                message,
                localUserId,
                localPeerId,
                ...options,
            });
        },

        markChatRead(message, options = {}) {
            return markChatRead({
                db,
                mesh,
                message,
                ...options,
            });
        },

        writeMarketItem(item) {
            return writeMarketItem({ item, saveNeighborItem });
        },

        normalizeCommunityMessage(message, options = {}) {
            return normalizeCommunityMessage(message, {
                localPeerId,
                ...options,
            });
        },

        mergeCommunityMessage(channelState, message, options = {}) {
            return mergeCommunityMessage(channelState, message, {
                localPeerId,
                ...options,
            });
        },

        loadCommunitySnapshot(options = {}) {
            return loadCommunitySnapshot({ db, ...options });
        },

        persistCommunitySnapshot(channelState, options = {}) {
            return persistCommunitySnapshot({
                db,
                channelState,
                ...options,
            });
        },

        snapshotCommunityState(channelState, options = {}) {
            return snapshotCommunityState(channelState, options);
        },
    };
}
