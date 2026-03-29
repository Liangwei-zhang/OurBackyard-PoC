export class InMemoryPS2Store {
    constructor() {
        this.messages = new Map(); // messageId -> message
        this.items = new Map(); // itemId -> item
        this.marketOps = new Set(); // opId set
    }

    saveMessage(message) {
        this.messages.set(message.id, { ...message });
    }

    patchMessage(messageId, patch) {
        const msg = this.messages.get(messageId);
        if (!msg) return;
        this.messages.set(messageId, { ...msg, ...patch });
    }

    getMessage(messageId) {
        return this.messages.get(messageId) || null;
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
        return this.marketOps.has(opId);
    }

    markMarketOp(opId) {
        this.marketOps.add(opId);
    }

    upsertItem(item) {
        const existing = this.items.get(item.id);
        if (!existing) {
            this.items.set(item.id, { ...item });
            return true;
        }
        const currentClock = Number(existing._clock || 0);
        const incomingClock = Number(item._clock || 0);
        if (incomingClock < currentClock) return false;
        if (incomingClock === currentClock && String(item._opId || "") <= String(existing._opId || "")) {
            return false;
        }
        this.items.set(item.id, { ...existing, ...item });
        return true;
    }

    getItem(itemId) {
        return this.items.get(itemId) || null;
    }

    listItems({ includeDeleted = false } = {}) {
        const rows = [...this.items.values()];
        return includeDeleted ? rows : rows.filter((i) => !i.deleted);
    }
}

