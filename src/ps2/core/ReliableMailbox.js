const DEFAULT_RETRY_MS = 1200;
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_TICK_MS = 250;

export class ReliableMailbox {
    constructor({
        nodeId,
        transport,
        now = () => Date.now(),
        retryMs = DEFAULT_RETRY_MS,
        maxRetries = DEFAULT_MAX_RETRIES,
        tickMs = DEFAULT_TICK_MS,
        idFactory = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    }) {
        this.nodeId = nodeId;
        this.transport = transport;
        this.now = now;
        this.retryMs = retryMs;
        this.maxRetries = maxRetries;
        this.tickMs = tickMs;
        this.idFactory = idFactory;

        this.pending = new Map(); // envelopeId -> pending state
        this.seen = new Map(); // envelopeId -> ts
        this.timer = null;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.flush(), this.tickMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    createEvent({
        topic,
        op,
        payload,
        to = null,
        reliable = false,
        id = null,
        clock = null,
    }) {
        return {
            v: 1,
            kind: "event",
            id: id || this.idFactory(),
            from: this.nodeId,
            to,
            reliable,
            topic,
            op,
            clock,
            ts: this.now(),
            payload,
        };
    }

    sendReliable({ to, topic, op, payload, id = null, clock = null }) {
        const envelope = this.createEvent({
            to,
            topic,
            op,
            payload,
            reliable: true,
            id,
            clock,
        });

        return new Promise((resolve, reject) => {
            this.pending.set(envelope.id, {
                envelope,
                attempts: 0,
                nextRetryAt: this.now(),
                resolve,
                reject,
            });
            this.flush();
        });
    }

    sendUnreliable({ to = null, topic, op, payload, id = null, clock = null, broadcast = false }) {
        const envelope = this.createEvent({
            to,
            topic,
            op,
            payload,
            reliable: false,
            id,
            clock,
        });

        if (broadcast) {
            this.transport.broadcast(envelope);
        } else if (to) {
            this.transport.send(to, envelope);
        }
        return envelope.id;
    }

    async receive(envelope, onEvent) {
        if (!envelope || envelope.v !== 1) return;

        if (envelope.kind === "ack") {
            this._handleAck(envelope);
            return;
        }
        if (envelope.kind !== "event") return;

        if (this._isSeen(envelope.id)) {
            if (envelope.reliable && envelope.from && envelope.to === this.nodeId) {
                this._sendAck(envelope.from, envelope.id);
            }
            return;
        }

        this._markSeen(envelope.id);
        await onEvent(envelope);

        if (envelope.reliable && envelope.from && envelope.to === this.nodeId) {
            this._sendAck(envelope.from, envelope.id);
        }
    }

    flush() {
        const now = this.now();
        this._gcSeen(now);
        for (const [id, pending] of this.pending.entries()) {
            if (pending.nextRetryAt > now) continue;

            if (pending.attempts >= this.maxRetries) {
                this.pending.delete(id);
                pending.reject(new Error(`Reliable send timeout: ${id}`));
                continue;
            }

            pending.attempts += 1;
            pending.envelope.attempt = pending.attempts;
            this.transport.send(pending.envelope.to, pending.envelope);
            const backoff = this.retryMs * Math.min(pending.attempts, 6);
            pending.nextRetryAt = now + backoff;
        }
    }

    _handleAck(ack) {
        const pending = this.pending.get(ack.ackFor);
        if (!pending) return;
        this.pending.delete(ack.ackFor);
        pending.resolve({
            ok: true,
            ackId: ack.id,
            ackFor: ack.ackFor,
            at: ack.ts,
        });
    }

    _sendAck(to, ackFor) {
        const ack = {
            v: 1,
            kind: "ack",
            id: this.idFactory(),
            from: this.nodeId,
            to,
            ackFor,
            ts: this.now(),
        };
        this.transport.send(to, ack);
    }

    _isSeen(id) {
        return this.seen.has(id);
    }

    _markSeen(id) {
        this.seen.set(id, this.now());
    }

    _gcSeen(now) {
        if (this.seen.size < 1200) return;
        const cutoff = now - 10 * 60 * 1000;
        for (const [id, ts] of this.seen.entries()) {
            if (ts < cutoff) this.seen.delete(id);
        }
    }
}

