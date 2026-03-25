/**
 * utils.js — Shared pure utility functions.
 * Extracted from p2p-mesh.js. No state, no side effects.
 */

/**
 * Generate a RFC-4122 v4 UUID.
 * @returns {string}
 */
export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
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
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return ab2hex(buf);
}
