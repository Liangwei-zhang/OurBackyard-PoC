function _trimString(value, maxLen) {
    const out = String(value ?? "");
    return maxLen ? out.slice(0, maxLen) : out;
}

export function validatePS2UIChatEvent(message) {
    if (!message || typeof message !== "object") {
        return { ok: false, reason: "not_object" };
    }
    const hasText = typeof message.text === "string" && message.text.trim().length > 0;
    const hasMedia =
        !!message.media ||
        !!message.mediaType ||
        !!message.mediaHash ||
        !!message.mediaData;
    if (!hasText && !hasMedia) {
        return { ok: false, reason: "empty_payload" };
    }
    return { ok: true };
}

export function normalizePS2UIChatEvent(
    message,
    {
        direction = null,
        localUserId = null,
        localPeerId = null,
        now = () => Date.now(),
    } = {},
) {
    const valid = validatePS2UIChatEvent(message);
    if (!valid.ok) return null;

    const media = message.media || null;
    const senderUserId =
        message.senderUserId ||
        message.from ||
        (direction === "out" ? (localUserId || localPeerId || null) : null);
    const recipientUserId =
        message.recipientUserId ||
        message.to ||
        (direction === "in" ? (localUserId || localPeerId || null) : null);
    const id =
        message.id ||
        message.messageId ||
        `msg_${now()}_${Math.random().toString(36).slice(2, 8)}`;

    return {
        ...message,
        id: String(id),
        direction: direction || message.direction || null,
        senderUserId: senderUserId || null,
        recipientUserId: recipientUserId || null,
        from: senderUserId || message.from || null,
        to: recipientUserId || message.to || null,
        ts: Number(message.ts || message.timestamp || now()),
        text: _trimString(message.text ?? "", 4000),
        mediaType: media?.mediaType || message.mediaType || null,
        mediaHash: media?.hash || message.mediaHash || null,
        mediaMimeType: media?.mimeType || message.mediaMimeType || null,
        itemId: message.itemId ?? null,
    };
}
