/**
 * @file signature.js
 * @description Message signing and verification using ECDSA P-256 (anti-forgery for P2P messages).
 * Zero external dependencies.
 */

import { ab2hex, hex2ab } from '../utils.js';

const CURVE = 'P-256';
const HASH = 'SHA-256';

export class Signature {
  constructor() {
    /** @type {CryptoKeyPair|null} */
    this._keyPair = null;
    /** @type {string|null} cached public key JWK string */
    this._publicKeyJWK = null;
  }

  /**
   * Generate a new ECDSA signing key pair.
   * @returns {Promise<void>}
   */
  async init() {
    this._keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: CURVE },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);
    this._publicKeyJWK = JSON.stringify(jwk);
  }

  /**
   * Get this node's public key as a JWK string.
   * @returns {string}
   */
  getPublicKeyJWK() {
    if (!this._publicKeyJWK) throw new Error('Not initialized — call init() first');
    return this._publicKeyJWK;
  }

  /**
   * Sign a message string. Returns a hex-encoded DER signature.
   * @param {string} message
   * @returns {Promise<string>}
   */
  async sign(message) {
    if (!this._keyPair) throw new Error('Not initialized — call init() first');
    const encoded = new TextEncoder().encode(message);
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: HASH } },
      this._keyPair.privateKey,
      encoded,
    );
    return ab2hex(sigBuf);
  }

  /**
   * Verify a signature against a message and a public key JWK string.
   * @param {string} message
   * @param {string} signatureHex
   * @param {string} publicKeyJWK
   * @returns {Promise<boolean>}
   */
  static async verify(message, signatureHex, publicKeyJWK) {
    try {
      const jwk = JSON.parse(publicKeyJWK);
      const pubKey = await crypto.subtle.importKey(
        'jwk', jwk,
        { name: 'ECDSA', namedCurve: CURVE },
        false,
        ['verify'],
      );
      const encoded = new TextEncoder().encode(message);
      const sigBuf = hex2ab(signatureHex);
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: HASH } },
        pubKey,
        sigBuf,
        encoded,
      );
    } catch {
      return false;
    }
  }

  /** @returns {boolean} */
  isInitialized() { return this._keyPair !== null; }
}

export default Signature;
