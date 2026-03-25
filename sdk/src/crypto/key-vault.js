/**
 * @file key-vault.js
 * @description Secure key storage wrapping Web Crypto API with import/export support.
 * Keys are stored in-memory by default; callers may persist the exported form.
 * Zero external dependencies.
 */

import { EventBus } from '../event-bus.js';

/** Supported named curves */
const EC_CURVE = 'P-256';

export class KeyVault extends EventBus {
  constructor() {
    super();
    /** @type {Map<string, CryptoKey>} */
    this._keys = new Map();
  }

  /**
   * Generate a new ECDH key pair and store it under the given alias.
   * @param {string} alias
   * @returns {Promise<{ publicKey: CryptoKey, privateKey: CryptoKey }>}
   */
  async generateECDH(alias) {
    if (!alias) throw new TypeError('alias is required');
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: EC_CURVE },
      true,
      ['deriveKey', 'deriveBits'],
    );
    this._keys.set(`${alias}:pub`, pair.publicKey);
    this._keys.set(`${alias}:priv`, pair.privateKey);
    this.emit('key:generated', { alias, type: 'ECDH' });
    return pair;
  }

  /**
   * Generate a new ECDSA key pair for signing and store it under the given alias.
   * @param {string} alias
   * @returns {Promise<{ publicKey: CryptoKey, privateKey: CryptoKey }>}
   */
  async generateECDSA(alias) {
    if (!alias) throw new TypeError('alias is required');
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: EC_CURVE },
      true,
      ['sign', 'verify'],
    );
    this._keys.set(`${alias}:pub`, pair.publicKey);
    this._keys.set(`${alias}:priv`, pair.privateKey);
    this.emit('key:generated', { alias, type: 'ECDSA' });
    return pair;
  }

  /**
   * Retrieve a stored key by alias and role ('pub' | 'priv').
   * @param {string} alias
   * @param {'pub'|'priv'} role
   * @returns {CryptoKey|undefined}
   */
  get(alias, role) {
    return this._keys.get(`${alias}:${role}`);
  }

  /**
   * Export a key to JWK format.
   * @param {string} alias
   * @param {'pub'|'priv'} role
   * @returns {Promise<JsonWebKey>}
   */
  async exportJWK(alias, role) {
    const key = this.get(alias, role);
    if (!key) throw new Error(`Key not found: ${alias}:${role}`);
    return crypto.subtle.exportKey('jwk', key);
  }

  /**
   * Import a JWK and store it under the given alias.
   * @param {string} alias
   * @param {'pub'|'priv'} role
   * @param {JsonWebKey} jwk
   * @param {'ECDH'|'ECDSA'} algorithm
   * @returns {Promise<CryptoKey>}
   */
  async importJWK(alias, role, jwk, algorithm) {
    if (!alias) throw new TypeError('alias is required');
    const usages = algorithm === 'ECDSA'
      ? (role === 'priv' ? ['sign'] : ['verify'])
      : (role === 'priv' ? ['deriveKey', 'deriveBits'] : []);
    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: algorithm, namedCurve: EC_CURVE },
      true,
      usages,
    );
    this._keys.set(`${alias}:${role}`, key);
    this.emit('key:imported', { alias, role, algorithm });
    return key;
  }

  /**
   * Delete all keys under an alias.
   * @param {string} alias
   */
  delete(alias) {
    this._keys.delete(`${alias}:pub`);
    this._keys.delete(`${alias}:priv`);
    this.emit('key:deleted', { alias });
  }

  /**
   * List all stored key aliases (deduplicated).
   * @returns {string[]}
   */
  aliases() {
    return [...new Set([...this._keys.keys()].map(k => k.replace(/:(pub|priv)$/, '')))];
  }
}

export default KeyVault;
