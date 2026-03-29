export class IMModule {
    constructor(kernel) {
        this.kernel = kernel;
    }

    async sendText(to, text, { convId = null, itemId = null, id = null } = {}) {
        const clean = String(text || "").trim();
        if (!clean) throw new Error("empty_message");
        if (clean.length > 4000) throw new Error("message_too_long");

        const messageId = id || this.kernel.newId("msg");
        const payload = {
            messageId,
            convId,
            itemId,
            contentType: "text/plain",
            text: clean,
            media: null,
        };

        this.kernel.store.saveMessage({
            id: messageId,
            convId: convId || this.kernel.defaultConvId(to),
            from: this.kernel.nodeId,
            to,
            senderUserId: this.kernel.nodeId,
            recipientUserId: to,
            ts: this.kernel.now(),
            text: clean,
            media: null,
            status: "sending",
            direction: "out",
        });
        this.kernel.events.emit("im:outgoing", this.kernel.store.getMessage(messageId));

        try {
            await this.kernel.mailbox.sendReliable({
                to,
                topic: "im",
                op: "message",
                payload,
                clock: this.kernel.nextClock(),
            });
            this.kernel.store.patchMessage(messageId, {
                status: "delivered",
                deliveredAt: this.kernel.now(),
            });
            this.kernel.events.emit("im:delivered", this.kernel.store.getMessage(messageId));
        } catch (err) {
            this.kernel.store.patchMessage(messageId, {
                status: "failed",
                failedAt: this.kernel.now(),
                error: err?.message || String(err),
            });
            this.kernel.events.emit("im:failed", this.kernel.store.getMessage(messageId));
            throw err;
        }

        return messageId;
    }

    async sendMedia(
        to,
        {
            mediaType,
            cid = null,
            hash = null,
            bytes = null,
            mimeType = null,
            text = "",
            convId = null,
            itemId = null,
            id = null,
        } = {},
    ) {
        if (!mediaType) throw new Error("missing_media_type");
        const messageId = id || this.kernel.newId("msg");
        const payload = {
            messageId,
            convId,
            itemId,
            contentType: mimeType || "application/octet-stream",
            text: String(text || ""),
            media: {
                mediaType,
                cid,
                hash,
                bytes,
                mimeType: mimeType || "application/octet-stream",
            },
        };

        this.kernel.store.saveMessage({
            id: messageId,
            convId: convId || this.kernel.defaultConvId(to),
            from: this.kernel.nodeId,
            to,
            senderUserId: this.kernel.nodeId,
            recipientUserId: to,
            ts: this.kernel.now(),
            text: payload.text,
            media: payload.media,
            status: "sending",
            direction: "out",
        });
        this.kernel.events.emit("im:outgoing", this.kernel.store.getMessage(messageId));

        try {
            await this.kernel.mailbox.sendReliable({
                to,
                topic: "im",
                op: "message",
                payload,
                clock: this.kernel.nextClock(),
            });
            this.kernel.store.patchMessage(messageId, {
                status: "delivered",
                deliveredAt: this.kernel.now(),
            });
            this.kernel.events.emit("im:delivered", this.kernel.store.getMessage(messageId));
        } catch (err) {
            this.kernel.store.patchMessage(messageId, {
                status: "failed",
                failedAt: this.kernel.now(),
                error: err?.message || String(err),
            });
            this.kernel.events.emit("im:failed", this.kernel.store.getMessage(messageId));
            throw err;
        }

        return messageId;
    }

    async markRead(to, messageId) {
        if (!to || !messageId) return;
        await this.kernel.mailbox.sendReliable({
            to,
            topic: "im",
            op: "receipt.read",
            payload: { messageId, readAt: this.kernel.now() },
            clock: this.kernel.nextClock(),
        });
    }

    async requestSync(to, { since = 0, limit = 300 } = {}) {
        if (!to) return;
        await this.kernel.mailbox.sendReliable({
            to,
            topic: "im",
            op: "sync.request",
            payload: {
                since: Number(since || 0),
                limit: Math.max(1, Math.min(1000, Number(limit || 300))),
                requestedAt: this.kernel.now(),
            },
            clock: this.kernel.nextClock(),
        });
    }

    async syncPeers(peerIds = [], options = {}) {
        const peers = [...new Set((peerIds || []).filter(Boolean))];
        await Promise.all(peers.map((peerId) => this.requestSync(peerId, options).catch(() => null)));
    }

    async handleEvent(frame) {
        if (frame.op === "message") {
            const payload = frame.payload || {};
            const text = String(payload.text || "");
            const media = payload.media || null;
            const messageId = payload.messageId || frame.id;
            const convId = payload.convId || this.kernel.defaultConvId(frame.from);

            // Idempotent upsert for retries/duplicates
            if (!this.kernel.store.getMessage(messageId)) {
                this.kernel.store.saveMessage({
                    id: messageId,
                    convId,
                    from: frame.from,
                    to: this.kernel.nodeId,
                    senderUserId: frame.from,
                    recipientUserId: this.kernel.nodeId,
                    ts: frame.ts || this.kernel.now(),
                    text,
                    media,
                    status: "received",
                    direction: "in",
                    itemId: payload.itemId || null,
                });
            }
            this.kernel.events.emit("im:incoming", this.kernel.store.getMessage(messageId));
            return;
        }

        if (frame.op === "receipt.read") {
            const payload = frame.payload || {};
            const messageId = payload.messageId;
            if (!messageId) return;
            this.kernel.store.patchMessage(messageId, {
                status: "read",
                readAt: payload.readAt || this.kernel.now(),
            });
            this.kernel.events.emit("im:read", this.kernel.store.getMessage(messageId));
            return;
        }

        if (frame.op === "sync.request") {
            if (!frame.from) return;
            const since = Number(frame.payload?.since || 0);
            const limit = Math.max(1, Math.min(1000, Number(frame.payload?.limit || 300)));
            const rows = this.kernel.store
                .listConversation(this.kernel.nodeId, frame.from)
                .filter((m) => Number(m.ts || 0) >= since);
            const chunk = rows.slice(-limit);

            await this.kernel.mailbox.sendReliable({
                to: frame.from,
                topic: "im",
                op: "sync.response",
                payload: {
                    messages: chunk,
                    ts: this.kernel.now(),
                },
                clock: this.kernel.nextClock(frame.clock || 0),
            });
            return;
        }

        if (frame.op === "sync.response") {
            const rows = Array.isArray(frame.payload?.messages) ? frame.payload.messages : [];
            let inserted = 0;
            let updated = 0;

            for (const row of rows) {
                const msg = this._normalizeSyncMessage(row, frame.from);
                if (!msg || !msg.id) continue;
                const existing = this.kernel.store.getMessage(msg.id);

                if (!existing) {
                    this.kernel.store.saveMessage(msg);
                    inserted += 1;
                    if (msg.direction === "in") {
                        this.kernel.events.emit("im:incoming", this.kernel.store.getMessage(msg.id));
                    } else {
                        this.kernel.events.emit("im:outgoing", this.kernel.store.getMessage(msg.id));
                    }
                    continue;
                }

                const patch = {};
                if (!existing.readAt && msg.readAt) patch.readAt = msg.readAt;
                if (!existing.deliveredAt && msg.deliveredAt) patch.deliveredAt = msg.deliveredAt;
                if (!existing.failedAt && msg.failedAt) patch.failedAt = msg.failedAt;
                if (!existing.error && msg.error) patch.error = msg.error;
                if ((!existing.text || existing.text === "") && msg.text) patch.text = msg.text;
                if (!existing.media && msg.media) patch.media = msg.media;
                if (Object.keys(patch).length > 0) {
                    this.kernel.store.patchMessage(msg.id, patch);
                    updated += 1;
                }
            }

            this.kernel.events.emit("im:sync", {
                from: frame.from || null,
                total: rows.length,
                inserted,
                updated,
            });
        }
    }

    _normalizeSyncMessage(message, fromPeer) {
        if (!message || message.id == null) return null;

        const id = String(message.id);
        const from = message.from || fromPeer || null;
        const to = message.to || null;
        const convId = message.convId || this.kernel.defaultConvId(from || to || fromPeer);
        const direction =
            message.direction ||
            (from === this.kernel.nodeId ? "out" : "in");

        return {
            ...message,
            id,
            from,
            to,
            senderUserId: message.senderUserId || from || null,
            recipientUserId: message.recipientUserId || to || null,
            convId,
            direction,
            ts: Number(message.ts || this.kernel.now()),
        };
    }
}
