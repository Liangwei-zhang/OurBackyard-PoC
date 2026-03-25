/**
 * Shared utility functions for the P2P SDK.
 */

/**
 * Generate a random UUID v4.
 * @returns {string}
 */
export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Compute SHA-256 of a string or ArrayBuffer, returning hex string.
 * Works in both browser (SubtleCrypto) and Node.js (crypto module).
 * @param {string|ArrayBuffer|Uint8Array} data
 * @returns {Promise<string>}
 */
export async function sha256hex(data) {
  let buf;
  if (typeof data === 'string') {
    buf = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    buf = data;
  } else {
    buf = new Uint8Array(data);
  }

  // Node.js environment
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    hash.update(buf);
    return hash.digest('hex');
  }

  // Browser environment
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return ab2hex(hashBuf);
}

/**
 * Convert ArrayBuffer to hex string.
 * @param {ArrayBuffer} buf
 * @returns {string}
 */
export function ab2hex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hex2ab(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

/**
 * Simple logger that respects a log level.
 * @param {string} level - 'debug'|'info'|'warn'|'error'
 * @param {string} tag
 * @param {...*} args
 */
export function log(level, tag, ...args) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  if (level === 'error') console.error(msg, ...args);
  else if (level === 'warn') console.warn(msg, ...args);
  else console.log(msg, ...args);
}
