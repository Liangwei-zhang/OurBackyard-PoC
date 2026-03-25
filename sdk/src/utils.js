/**
 * @file utils.js
 * @description Pure utility functions: uuid(), sha256hex(), ab2hex(), hex2ab().
 * Zero external dependencies — uses only Web Crypto API.
 */

/**
 * Generate a cryptographically random UUID v4.
 * Falls back to Math.random() in environments without crypto.randomUUID.
 * @returns {string}
 */
export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: RFC4122 v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Compute SHA-256 of a string and return lowercase hex string.
 * @param {string} str
 * @returns {Promise<string>}
 */
export async function sha256hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return ab2hex(buf);
}

/**
 * Convert an ArrayBuffer or Uint8Array to a lowercase hex string.
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {string}
 */
export function ab2hex(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert a hex string to an ArrayBuffer.
 * @param {string} hex
 * @returns {ArrayBuffer}
 */
export function hex2ab(hex) {
  if (hex.length % 2 !== 0) throw new RangeError('hex string must have even length');
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf.buffer;
}
