import "fake-indexeddb/auto";
import Dexie from "dexie";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";

if (!globalThis.Buffer) {
    globalThis.Buffer = Buffer;
}

globalThis.Dexie = Dexie;
if (typeof window !== "undefined") {
    window.Dexie = Dexie;
}

if (!globalThis.crypto?.subtle) {
    globalThis.crypto = webcrypto;
}

if (typeof globalThis.btoa !== "function") {
    globalThis.btoa = (str) => Buffer.from(str, "binary").toString("base64");
}

if (typeof globalThis.atob !== "function") {
    globalThis.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
}

if (!globalThis.URL.createObjectURL) {
    let blobId = 0;
    globalThis.URL.createObjectURL = () => `blob:mock-${++blobId}`;
}

if (!globalThis.URL.revokeObjectURL) {
    globalThis.URL.revokeObjectURL = () => {};
}

if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class {
        constructor(callback) {
            this.callback = callback;
        }

        observe() {}

        unobserve() {}

        disconnect() {}
    };
}

globalThis.confirm = () => true;

if (!globalThis.navigator.vibrate) {
    globalThis.navigator.vibrate = () => true;
}

globalThis.__resetDom = () => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
};

globalThis.__loadScript = async (relativePath) => {
    const absolute = path.resolve(process.cwd(), relativePath);
    const url = pathToFileURL(absolute);
    url.searchParams.set("t", String(Date.now()) + Math.random());
    await import(url.href);
};

globalThis.__flushPromises = async () => {
    await Promise.resolve();
    await Promise.resolve();
};
