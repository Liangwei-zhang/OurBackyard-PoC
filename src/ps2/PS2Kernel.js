import { SimpleEmitter } from "./core/SimpleEmitter.js";
import { ReliableMailbox } from "./core/ReliableMailbox.js";
import { IMModule } from "./modules/IMModule.js";
import { MarketModule } from "./modules/MarketModule.js";
import { InMemoryPS2Store } from "./store/InMemoryPS2Store.js";

export class PS2Kernel {
    constructor({
        nodeId,
        transport,
        store = new InMemoryPS2Store(),
        now = () => Date.now(),
        mailboxOptions = {},
        autoSyncMs = 0,
    }) {
        if (!nodeId) throw new Error("PS2Kernel requires nodeId");
        if (!transport) throw new Error("PS2Kernel requires transport");

        this.nodeId = nodeId;
        this.transport = transport;
        this.store = store;
        this.now = now;
        this.autoSyncMs = Number(autoSyncMs || 0);

        this.events = new SimpleEmitter();
        this.clock = 0;

        this.mailbox = new ReliableMailbox({
            nodeId,
            transport,
            now,
            ...mailboxOptions,
        });

        this.im = new IMModule(this);
        this.market = new MarketModule(this);
        this.modules = new Map([
            ["im", this.im],
            ["market", this.market],
        ]);

        this.started = false;
        this._autoSyncTimer = null;
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.mailbox.start();
        this.transport.setMessageHandler(async (frame) => {
            await this._onTransportFrame(frame);
        });
        this._startAutoSync();
    }

    stop() {
        this.mailbox.stop();
        this._stopAutoSync();
        this.started = false;
    }

    newId(prefix = "id") {
        return `${prefix}_${this.nodeId}_${this.now()}_${Math.random().toString(16).slice(2, 9)}`;
    }

    nextClock(remoteClock = 0) {
        this.clock = Math.max(this.clock, Number(remoteClock || 0)) + 1;
        return this.clock;
    }

    defaultConvId(peerId) {
        const pair = [this.nodeId, String(peerId || "")].sort();
        return `conv:${pair[0]}:${pair[1]}`;
    }

    async _onTransportFrame(frame) {
        await this.mailbox.receive(frame, async (eventFrame) => {
            this.nextClock(eventFrame.clock || 0);
            const module = this.modules.get(eventFrame.topic);
            if (!module || typeof module.handleEvent !== "function") return;
            await module.handleEvent(eventFrame);
            this.events.emit("frame:handled", eventFrame);
        });
    }

    _startAutoSync() {
        this._stopAutoSync();
        if (!this.autoSyncMs || this.autoSyncMs < 1000) return;
        this._autoSyncTimer = setInterval(() => {
            try {
                const peers = this.transport?.listPeers?.() || [];
                if (peers.length > 0) {
                    this.market.syncPeers(peers).catch(() => null);
                    this.im.syncPeers(peers, { limit: 200 }).catch(() => null);
                }
            } catch {
                // Non-fatal background sync loop
            }
        }, this.autoSyncMs);
    }

    _stopAutoSync() {
        if (!this._autoSyncTimer) return;
        clearInterval(this._autoSyncTimer);
        this._autoSyncTimer = null;
    }
}
