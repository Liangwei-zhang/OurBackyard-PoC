export class SimpleEmitter {
    constructor() {
        this.listeners = new Map();
    }

    on(event, handler) {
        const set = this.listeners.get(event) || new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return () => this.off(event, handler);
    }

    off(event, handler) {
        const set = this.listeners.get(event);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) this.listeners.delete(event);
    }

    emit(event, payload) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of set) {
            try {
                handler(payload);
            } catch (err) {
                // Keep emitter resilient; one bad handler should not block others.
                console.warn(`[PS2] Event handler failed for ${event}:`, err?.message || err);
            }
        }
    }
}

