export class MarketModule {
    constructor(kernel) {
        this.kernel = kernel;
    }

    publishItem(input) {
        const itemId = input?.id || this.kernel.newId("item");
        const clock = this.kernel.nextClock();
        const nowTs = this.kernel.now();
        const imageHashes = Array.isArray(input?.imageHashes)
            ? input.imageHashes.filter(Boolean).map((h) => String(h))
            : (input?.imageHash ? [String(input.imageHash)] : []);
        const imageHash = input?.imageHash ? String(input.imageHash) : (imageHashes[0] || null);
        const ownerUserId = input?.ownerUserId || input?.sellerId || this.kernel.nodeId;
        const patch = {
            ...input,
            id: itemId,
            title: String(input?.title || ""),
            description: String(input?.description || ""),
            category: input?.category || "General",
            price: input?.price ?? 0,
            status: input?.status || "available",
            sellerId: input?.sellerId || ownerUserId,
            ownerUserId,
            imageHash,
            imageHashes,
            timestamp: input?.timestamp || nowTs,
            updatedAt: input?.updatedAt || nowTs,
            media: input?.media || null,
            deleted: false,
        };
        const op = {
            opId: this.kernel.newId("op"),
            type: "create",
            itemId,
            clock,
            ts: nowTs,
            author: this.kernel.nodeId,
            patch,
        };
        this._applyLocalOp(op);
        this._broadcastOp(op);
        return itemId;
    }

    updateItem(itemId, patch = {}) {
        if (!itemId) throw new Error("missing_item_id");
        const clock = this.kernel.nextClock();
        const op = {
            opId: this.kernel.newId("op"),
            type: "update",
            itemId,
            clock,
            ts: this.kernel.now(),
            author: this.kernel.nodeId,
            patch: { ...patch, id: itemId },
        };
        this._applyLocalOp(op);
        this._broadcastOp(op);
        return op.opId;
    }

    deleteItem(itemId) {
        if (!itemId) throw new Error("missing_item_id");
        const clock = this.kernel.nextClock();
        const op = {
            opId: this.kernel.newId("op"),
            type: "delete",
            itemId,
            clock,
            ts: this.kernel.now(),
            author: this.kernel.nodeId,
            patch: {
                id: itemId,
                status: "gone",
                deleted: true,
            },
        };
        this._applyLocalOp(op);
        this._broadcastOp(op);
        return op.opId;
    }

    listItems(options = {}) {
        return this.kernel.store.listItems(options);
    }

    getItem(itemId) {
        return this.kernel.store.getItem(itemId);
    }

    async requestSync(peerId) {
        if (!peerId) return;
        await this.kernel.mailbox.sendReliable({
            to: peerId,
            topic: "market",
            op: "sync.request",
            payload: {
                includeDeleted: true,
                requestedAt: this.kernel.now(),
            },
            clock: this.kernel.nextClock(),
        });
    }

    async syncPeers(peerIds = []) {
        const peers = [...new Set((peerIds || []).filter(Boolean))];
        await Promise.all(peers.map((peerId) => this.requestSync(peerId).catch(() => null)));
    }

    async handleEvent(frame) {
        if (frame.op === "op") {
            const op = frame.payload?.op;
            if (!op || !op.opId) return;
            if (this.kernel.store.hasMarketOp(op.opId)) return;
            this._applyLocalOp(op, { remote: true });
            return;
        }

        if (frame.op === "sync.request") {
            if (!frame.from) return;
            const items = this.kernel.store.listItems({ includeDeleted: true });
            await this.kernel.mailbox.sendReliable({
                to: frame.from,
                topic: "market",
                op: "sync.response",
                payload: {
                    items,
                    ts: this.kernel.now(),
                },
                clock: this.kernel.nextClock(frame.clock || 0),
            });
            return;
        }

        if (frame.op === "sync.response") {
            const items = Array.isArray(frame.payload?.items) ? frame.payload.items : [];
            let applied = 0;
            for (const incoming of items) {
                if (this._applySnapshotItem(incoming, frame.from)) {
                    applied += 1;
                }
            }
            this.kernel.events.emit("market:sync", {
                from: frame.from || null,
                applied,
                total: items.length,
            });
        }
    }

    _broadcastOp(op) {
        this.kernel.mailbox.sendUnreliable({
            topic: "market",
            op: "op",
            payload: { op },
            broadcast: true,
            clock: op.clock,
        });
    }

    _applyLocalOp(op, { remote = false } = {}) {
        if (this.kernel.store.hasMarketOp(op.opId)) return;
        this.kernel.store.markMarketOp(op.opId);

        const existing = this.kernel.store.getItem(op.itemId) || {
            id: op.itemId,
            createdAt: op.ts,
            sellerId: op.author,
            ownerUserId: op.author,
            deleted: false,
        };

        const merged = {
            ...existing,
            ...op.patch,
            id: op.itemId,
            ownerUserId: op.patch?.ownerUserId || existing.ownerUserId || op.patch?.sellerId || existing.sellerId || op.author,
            updatedAt: op.ts,
            _clock: op.clock,
            _opId: op.opId,
            _author: op.author,
        };

        const changed = this.kernel.store.upsertItem(merged);
        if (!changed) return;

        this.kernel.events.emit("market:item", {
            type: op.type,
            item: this.kernel.store.getItem(op.itemId),
            op,
            remote,
        });
    }

    _applySnapshotItem(item, fromPeerId = null) {
        if (!item || item.id == null) return false;
        const clock = Number(item._clock ?? item.updatedAt ?? item.ts ?? 0);
        const opId = String(item._opId || `snapshot_${fromPeerId || "peer"}_${item.id}_${clock}`);
        const normalized = {
            ...item,
            id: item.id,
            ownerUserId: item.ownerUserId || item.sellerId || fromPeerId || null,
            _clock: clock,
            _opId: opId,
            _author: item._author || fromPeerId || "snapshot",
        };

        const changed = this.kernel.store.upsertItem(normalized);
        if (!changed) return false;

        this.kernel.events.emit("market:item", {
            type: "sync",
            item: this.kernel.store.getItem(item.id),
            op: {
                opId,
                type: "sync",
                itemId: item.id,
                clock,
                ts: this.kernel.now(),
                author: normalized._author,
                patch: normalized,
            },
            remote: true,
        });
        return true;
    }
}
