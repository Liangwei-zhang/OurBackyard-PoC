import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("src/utils modules", () => {
    beforeAll(async () => {
        await __loadScript("src/utils/xss.js");
        await __loadScript("src/utils/errorHandler.js");
        await __loadScript("src/utils/utils.js");
        await __loadScript("src/utils/debouncer.js");
    });

    beforeEach(() => {
        __resetDom();
        window.ErrorHandler.clear();
    });

    it("escapes and validates urls safely", () => {
        expect(window.XSSSanitizer.escapeHtml(`<a>"x"&</a>`)).toBe("&lt;a&gt;&quot;x&quot;&amp;&lt;/a&gt;");
        expect(window.XSSSanitizer.isSafeUrl("https://example.com")).toBe(true);
        expect(window.XSSSanitizer.isSafeUrl("javascript:alert(1)")).toBe(false);
        expect(window.XSSSanitizer.getSafeUrl("javascript:alert(1)")).toBe("");
    });

    it("only sets safe attributes", () => {
        const el = document.createElement("a");
        window.XSSSanitizer.setAttribute(el, "href", "https://safe.example");
        window.XSSSanitizer.setAttribute(el, "onclick", "alert(1)");

        expect(el.getAttribute("href")).toBe("https://safe.example");
        expect(el.getAttribute("onclick")).toBeNull();
    });

    it("captures errors via safe wrappers", async () => {
        const syncResult = window.ErrorHandler.safeSync(() => {
            throw new Error("sync-fail");
        }, "fallback-sync");
        expect(syncResult).toBe("fallback-sync");

        const asyncResult = await window.ErrorHandler.safeAsync(async () => {
            throw new Error("async-fail");
        }, "fallback-async");
        expect(asyncResult).toBe("fallback-async");

        expect(window.ErrorHandler.getRecentErrors(5).length).toBeGreaterThanOrEqual(2);
        expect(window.ErrorHandler.hasRecentErrors(1000)).toBe(true);
    });

    it("validates image files and formats bytes", () => {
        expect(window.Utils.validateImage({ type: "image/jpeg", size: 1024 }).valid).toBe(true);
        expect(window.Utils.validateImage({ type: "text/plain", size: 10 }).valid).toBe(false);
        expect(window.Utils.validateImage({ type: "image/png", size: 11 * 1024 * 1024 }).valid).toBe(false);

        expect(window.Utils.formatBytes(0)).toBe("0 B");
        expect(window.Utils.formatBytes(1024)).toBe("1 KB");
    });

    it("debounces and throttles utility functions", () => {
        vi.useFakeTimers();

        const dfn = vi.fn();
        const debounced = window.Utils.debounce(dfn, 50);
        debounced("a");
        debounced("b");
        vi.advanceTimersByTime(50);
        expect(dfn).toHaveBeenCalledTimes(1);
        expect(dfn).toHaveBeenCalledWith("b");

        const tfn = vi.fn();
        const throttled = window.Utils.throttle(tfn, 100);
        throttled();
        throttled();
        expect(tfn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(100);
        throttled();
        expect(tfn).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
    });

    it("shows toast and removes previous one", () => {
        vi.useFakeTimers();
        window.Utils.showToast("first", "info");
        window.Utils.showToast("second", "success");

        const toasts = document.querySelectorAll(".toast-notification");
        expect(toasts.length).toBe(1);
        expect(toasts[0].textContent).toContain("second");

        vi.advanceTimersByTime(3301);
        expect(document.querySelector(".toast-notification")).toBeNull();
        vi.useRealTimers();
    });

    it("exposes working Debouncer/Throttler wrappers", () => {
        vi.useFakeTimers();

        const fn = vi.fn();
        const wrappedDebounce = window.debounce(fn, 40);
        wrappedDebounce("x");
        vi.advanceTimersByTime(40);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith("x");

        const throttledFn = vi.fn();
        const wrappedThrottle = window.throttle(throttledFn, 100);
        wrappedThrottle(1);
        wrappedThrottle(2);
        expect(throttledFn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(100);
        expect(throttledFn).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
    });
});

