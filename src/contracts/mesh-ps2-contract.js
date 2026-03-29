export function validatePS2FrameMessage(msg) {
    if (!msg || typeof msg !== "object") {
        return { ok: false, reason: "not_object" };
    }
    if (msg.type !== "PS2_FRAME") {
        return { ok: false, reason: "wrong_type" };
    }
    const frame = msg.frame;
    if (!frame || typeof frame !== "object") {
        return { ok: false, reason: "missing_frame" };
    }
    if (Number(frame.v) !== 1) {
        return { ok: false, reason: "wrong_version" };
    }
    if (frame.kind === "event") {
        if (!frame.id || !frame.from || !frame.topic || !frame.op) {
            return { ok: false, reason: "invalid_event" };
        }
        return { ok: true };
    }
    if (frame.kind === "ack") {
        if (!frame.id || !frame.from || !frame.ackFor) {
            return { ok: false, reason: "invalid_ack" };
        }
        return { ok: true };
    }
    return { ok: false, reason: "unknown_kind" };
}

export function isValidPS2FrameMessage(msg) {
    return validatePS2FrameMessage(msg).ok === true;
}
