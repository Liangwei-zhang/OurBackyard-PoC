export class DexiePS2Store {
    constructor({
        db,
        now = () => Date.now(),
        messageTable = "chatMessagesV2",
        itemTable = "items",
        syncTable = "sync",
        marketOpType = "ps2.market.op",
    } = {}) {
        this.db = db || null;
        this.now = now;

        this.messageTable = messageTable;
        this.itemTable = itemTable;
        this.syncTable = syncTable;
        this.marketOpType = marketOpType;

        this.messages = new Map(); // messageId -> message
        this.items = new Map(); // itemId -> item
        this.marketOps = new Set(); // opId set

        this._writeQueue = Promise.resolve();
        this.ready = this._hydrate();
    }

    _messageTable() {
        return (
            this.db?.[this.messageTable] ||
            this.db?.chatMessagesV2 ||
            this.db?.chatMessages ||
            null
        );
    }

    async _hydrate() {
        if (!this.db) return;

        await Promise.all([
            this._hydrateMessages(),
            this._hydrateItems(),
            this._hydrateMarketOps(),
        ]);
    }

    async _hydrateMessages() {
        const table = this._messageTable();
        if (!table?.toArray) return;
        const rows = await table.toArray().catch(() => []);
        for (const row of rows) {
            if (!row || row.id == null) continue;
            this.messages.set(String(row.id), { ...row });
        }
    }

    async _hydrateItems() {
        const table = this.db?.[this.itemTable];
        if (!table?.toArray) return;
        const rows = await table.toArray().catch(() => []);
        for (const row of rows) {
            if (!row || row.id == null) continue;
            this.items.set(String(row.id), { ...row });
        }
    }

    async _hydrateMarketOps() {
        const table = this.db?.[this.syncTable];
        if (!table) return;

        let rows = [];
        if (typeof table.where === "function") {
            rows = await table.where("type").equals(this.marketOpType).toArray().catch(() => []);
        }
        if (!rows.length && typeof table.toArray === "function") {
            rows = (await table.toArray().catch(() => [])).filter((r) => r?.type === this.marketOpType);
        }

        for (const row of rows) {
            const opId = row?.opId || this._extractOpId(row?.key);
            if (opId) this.marketOps.add(String(opId));
        }
    }

    _extractOpId(key) {
        if (!key || typeof key !== "string") return null;
        const idx = key.lastIndexOf(":");
        if (idx < 0) return null;
        return key.slice(idx + 1);
    }

    _enqueueWrite(task) {
        if (!this.db) return;
        this._writeQueue = this._writeQueue.then(() => task()).catch(() => {});
    }

    saveMessage(message) {
        if (!message || message.id == null) return;
        const normalized = { ...message, id: String(message.id) };
        this.messages.set(normalized.id, normalized);
        this._enqueueWrite(async () => {
            await this._messageTable()?.put?.({ ...normalized });
        });
    }

    patchMessage(messageId, patch) {
        const id = String(messageId || "");
        const msg = this.messages.get(id);
        if (!msg) return;
        const merged = { ...msg, ...patch, id };
        this.messages.set(id, merged);
        this._enqueueWrite(async () => {
            await this._messageTable()?.put?.({ ...merged });
        });
    }

    getMessage(messageId) {
        return this.messages.get(String(messageId || "")) || null;
    }

    listConversation(nodeA, nodeB) {
        return [...this.messages.values()]
            .filter(
                (m) =>
                    (m.from === nodeA && m.to === nodeB) ||
                    (m.from === nodeB && m.to === nodeA),
            )
            .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }

    hasMarketOp(opId) {
        return this.marketOps.has(String(opId || ""));
    }

    markMarketOp(opId) {
        const id = String(opId || "");
        if (!id || this.marketOps.has(id)) return;
        this.marketOps.add(id);
        this._enqueueWrite(async () => {
            await this.db?.[this.syncTable]?.put?.({
                type: this.marketOpType,
                key: `${this.marketOpType}:${id}`,
                opId: id,
                ts: this.now(),
            });
        });
    }

    upsertItem(item) {
        if (!item || item.id == null) return false;
        const itemId = String(item.id);
        const existing = this.items.get(itemId);
        if (!existing) {
            const first = { ...item, id: item.id };
            this.items.set(itemId, first);
            this._enqueueWrite(async () => {
                await this.db?.[this.itemTable]?.put?.({ ...first });
            });
            return true;
        }

        const currentClock = Number(existing._clock || 0);
        const incomingClock = Number(item._clock || 0);
        if (incomingClock < currentClock) return false;
        if (incomingClock === currentClock && String(item._opId || "") <= String(existing._opId || "")) {
            return false;
        }

        const merged = { ...existing, ...item, id: existing.id ?? item.id };
        this.items.set(itemId, merged);
        this._enqueueWrite(async () => {
            await this.db?.[this.itemTable]?.put?.({ ...merged });
        });
        return true;
    }

    getItem(itemId) {
        return this.items.get(String(itemId || "")) || null;
    }

    listItems({ includeDeleted = false } = {}) {
        const rows = [...this.items.values()];
        return includeDeleted ? rows : rows.filter((i) => !i.deleted);
    }
}
