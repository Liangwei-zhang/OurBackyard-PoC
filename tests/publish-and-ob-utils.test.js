import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("publish-guard and ob-utils", () => {
    beforeAll(async () => {
        await __loadScript("publish-guard.js");
        await __loadScript("ob-utils.js");
    });

    beforeEach(() => {
        __resetDom();
        window.PublishGuard.clear();
    });

    it("rejects missing publish token", async () => {
        const result = await window.PublishGuard.verify("");
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("no_token");
    });

    it("accepts generated dev token when public key is not configured", async () => {
        const token = window.PublishGuard.generateDevToken({ merchantId: "m-1", days: 1 });
        const result = await window.PublishGuard.verify(token);

        expect(result.ok).toBe(true);
        expect(result.devMode).toBe(true);
        expect(result.payload.sub).toBe("m-1");
    });

    it("returns expired for past token", async () => {
        const token = window.PublishGuard.generateDevToken({ merchantId: "m-2", days: -1 });
        const result = await window.PublishGuard.verify(token);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("expired");
    });

    it("can save/load/clear token state", async () => {
        const token = window.PublishGuard.generateDevToken({ merchantId: "merchant" });
        window.PublishGuard.save(token);
        expect(window.PublishGuard.load()).toBe(token);

        const status = await window.PublishGuard.getStatus();
        expect(status.state).toBe("valid");
        expect(status.merchantId).toBe("merchant");

        window.PublishGuard.clear();
        expect(window.PublishGuard.load()).toBe("");
        expect(await window.PublishGuard.getStatus()).toEqual({ state: "none" });
    });

    it("escapes html and formats price", () => {
        expect(window.OBUtils.esc(`<b>"x"</b>`)).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
        expect(window.OBUtils.formatPrice(0)).toBe("🎁 Free");
        expect(window.OBUtils.formatPrice("swap")).toBe("☕ Swap");
        expect(window.OBUtils.formatPrice(20)).toBe("$20");
    });

    it("sanitizes control characters", () => {
        expect(window.OBUtils.sanitize("a\u0000b\tc\n", 10)).toBe("ab\tc\n");
    });

    it("debounces calls and keeps last args", () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = window.OBUtils.debounce(fn, 80);

        debounced("first");
        debounced("second");
        vi.advanceTimersByTime(79);
        expect(fn).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith("second");
        vi.useRealTimers();
    });

    it("creates escaped toast content", () => {
        vi.useFakeTimers();
        const toast = window.OBUtils.notify(`<img src=x onerror=1>`, "info", 50);
        expect(toast.innerHTML).not.toContain("<img");
        expect(toast.textContent).toContain("<img src=x onerror=1>");

        vi.advanceTimersByTime(300);
        expect(document.querySelector("#ob-toast-container")).toBeTruthy();
        vi.useRealTimers();
    });
});

