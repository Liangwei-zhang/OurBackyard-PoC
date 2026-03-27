/**
 * utils.js — Shared pure utility functions.
 * Extracted from p2p-mesh.js. No state, no side effects.
 */

/**
 * Generate a RFC-4122 v4 UUID using the CSPRNG.
 * @returns {string}
 */
export function uuid() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  a[6] = (a[6] & 0x0f) | 0x40; // version 4
  a[8] = (a[8] & 0x3f) | 0x80; // variant 1
  const h = Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

/**
 * Convert an ArrayBuffer (or Uint8Array / ArrayBufferView) to a lowercase hex string.
 * @param {ArrayBuffer|Uint8Array} ab
 * @returns {string}
 */
export function ab2hex(ab) {
  const bytes = ab instanceof ArrayBuffer
    ? new Uint8Array(ab)
    : (ArrayBuffer.isView(ab) ? new Uint8Array(ab.buffer, ab.byteOffset, ab.byteLength) : new Uint8Array(ab));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert a lowercase hex string to an ArrayBuffer.
 * @param {string} hex
 * @returns {ArrayBuffer}
 */
export function hex2ab(hex) {
  if (hex.length % 2 !== 0) throw new RangeError('hex2ab: odd-length hex string');
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr.buffer;
}

/**
 * Compute SHA-256 of a string and return lowercase hex.
 * Uses the Web Crypto API (browser + Node ≥ 15).
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256hex(text) {
  if (!crypto?.subtle) throw new Error('crypto.subtle is not available in this context (requires secure context or Node ≥ 15)');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return ab2hex(buf);
}
