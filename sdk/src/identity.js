/**
 * @file identity.js
 * @description DID-like identity generation, persistence, and import/export.
 * Identity = { id, publicKeyJWK, signingKeyJWK, createdAt }
 * The private keys are NOT exported/persisted — only the public keys.
 * Zero external dependencies.
 */

import { EventBus } from './event-bus.js';
import { uuid, sha256hex } from './utils.js';
import config from './config.js';

const CURVE = 'P-256';

export class Identity extends EventBus {
  constructor() {
    super();
    /** @type {{ id: string, publicKeyJWK: string, signingKeyJWK: string, createdAt: number }|null} */
    this._identity = null;
    /** @type {CryptoKey|null} */
    this._ecdhPrivate = null;
    /** @type {CryptoKey|null} */
    this._ecdsaPrivate = null;
  }

  /**
   * Generate a new identity. If localStorage is available and a persisted identity
   * exists under the configured storage key, it will be loaded instead.
   * @returns {Promise<{ id: string, publicKeyJWK: string, signingKeyJWK: string, createdAt: number }>}
   */
  async init() {
    const storageKey = config.get('identity.storageKey');
    // Try to load persisted identity
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed.id && parsed.publicKeyJWK && parsed.signingKeyJWK) {
            this._identity = parsed;
            this.emit('identity:loaded', this._identity);
            return this._identity;
          }
        } catch { console.warn('[Identity] Stored identity data is corrupted; regenerating.'); }
      }
    }
    return this._generate();
  }

  async _generate() {
    // ECDH key pair for encryption
    const ecdhPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: CURVE }, true, ['deriveKey', 'deriveBits'],
    );
    // ECDSA key pair for signing
    const ecdsaPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: CURVE }, true, ['sign', 'verify'],
    );
    this._ecdhPrivate = ecdhPair.privateKey;
    this._ecdsaPrivate = ecdsaPair.privateKey;
    // Note: private keys are ephemeral (in-memory only) and lost on page reload.
    // After reload, init() restores the public identity from localStorage, but
    // peers must re-exchange keys to establish new shared secrets.

    const ecdhPubJWK = await crypto.subtle.exportKey('jwk', ecdhPair.publicKey);
    const ecdsaPubJWK = await crypto.subtle.exportKey('jwk', ecdsaPair.publicKey);

    const publicKeyJWK = JSON.stringify(ecdhPubJWK);
    const signingKeyJWK = JSON.stringify(ecdsaPubJWK);
    // Derive a stable DID-like ID from the ECDH public key
    const id = `did:ob:${await sha256hex(publicKeyJWK)}`;

    this._identity = { id, publicKeyJWK, signingKeyJWK, createdAt: Date.now() };

    const storageKey = config.get('identity.storageKey');
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey, JSON.stringify(this._identity));
    }
    this.emit('identity:created', this._identity);
    return this._identity;
  }

  /** @returns {{ id: string, publicKeyJWK: string, signingKeyJWK: string, createdAt: number }} */
  get() {
    if (!this._identity) throw new Error('Identity not initialized — call init() first');
    return { ...this._identity };
  }

  /** @returns {string} */
  get id() { return this.get().id; }

  /** @returns {CryptoKey|null} */
  get ecdhPrivateKey() { return this._ecdhPrivate; }

  /** @returns {CryptoKey|null} */
  get ecdsaPrivateKey() { return this._ecdsaPrivate; }

  /**
   * Export the identity bundle (public keys + metadata only).
   * @returns {string} JSON string
   */
  export() {
    return JSON.stringify(this.get());
  }

  /**
   * Clear persisted identity from localStorage and reset in-memory state.
   */
  reset() {
    const storageKey = config.get('identity.storageKey');
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(storageKey);
    }
    this._identity = null;
    this._ecdhPrivate = null;
    this._ecdsaPrivate = null;
    this.emit('identity:reset', {});
  }

  /** @returns {boolean} */
  isInitialized() { return this._identity !== null; }
}

export default Identity;
