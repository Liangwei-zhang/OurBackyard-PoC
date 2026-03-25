/**
 * @file e2e-crypto.js
 * @description ECDH key exchange + AES-256-GCM encryption/decryption with proper IV handling.
 * Zero external dependencies — uses only Web Crypto API.
 */

import { EventBus } from '../event-bus.js';
import { ab2hex, hex2ab } from '../utils.js';

const CURVE = 'P-256';
const AES_ALGO = 'AES-GCM';
const AES_KEY_LENGTH = 256;
const IV_BYTES = 12;

export class E2ECrypto extends EventBus {
  constructor() {
    super();
    /** @type {CryptoKeyPair|null} */
    this._keyPair = null;
    /** @type {Map<string, CryptoKey>} peerId → derived AES key */
    this._sharedKeys = new Map();
  }

  /**
   * Generate a new ECDH key pair for this node.
   * @returns {Promise<void>}
   */
  async init() {
    this._keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: CURVE },
      true,
      ['deriveKey', 'deriveBits'],
    );
    this.emit('ready', {});
  }

  /**
   * Export the local public key as a JWK string.
   * @returns {Promise<string>}
   */
  async getPublicKeyJWK() {
    if (!this._keyPair) throw new Error('Not initialized — call init() first');
    const jwk = await crypto.subtle.exportKey('jwk', this._keyPair.publicKey);
    return JSON.stringify(jwk);
  }

  /**
   * Derive a shared AES-GCM key from the remote peer's public key JWK.
   * @param {string} peerId
   * @param {string} remotePublicKeyJWK
   * @returns {Promise<void>}
   */
  async deriveSharedKey(peerId, remotePublicKeyJWK) {
    if (!this._keyPair) throw new Error('Not initialized — call init() first');
    if (!peerId) throw new TypeError('peerId is required');
    const jwk = JSON.parse(remotePublicKeyJWK);
    const remotePub = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'ECDH', namedCurve: CURVE },
      false,
      [],
    );
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: remotePub },
      this._keyPair.privateKey,
      { name: AES_ALGO, length: AES_KEY_LENGTH },
      false,
      ['encrypt', 'decrypt'],
    );
    this._sharedKeys.set(peerId, aesKey);
    this.emit('key:derived', { peerId });
  }

  /**
   * Encrypt a UTF-8 string for the given peer.
   * @param {string} peerId
   * @param {string} plaintext
   * @returns {Promise<string>} hex-encoded `iv + ciphertext`
   */
  async encrypt(peerId, plaintext) {
    const key = this._sharedKeys.get(peerId);
    if (!key) throw new Error(`No shared key for peer ${peerId}`);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, encoded);
    // Prepend IV to ciphertext
    const result = new Uint8Array(IV_BYTES + cipherBuf.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(cipherBuf), IV_BYTES);
    return ab2hex(result);
  }

  /**
   * Decrypt a hex-encoded `iv + ciphertext` from the given peer.
   * @param {string} peerId
   * @param {string} hex
   * @returns {Promise<string>} plaintext
   */
  async decrypt(peerId, hex) {
    const key = this._sharedKeys.get(peerId);
    if (!key) throw new Error(`No shared key for peer ${peerId}`);
    const raw = new Uint8Array(hex2ab(hex));
    const iv = raw.slice(0, IV_BYTES);
    const cipherBuf = raw.slice(IV_BYTES);
    const plainBuf = await crypto.subtle.decrypt({ name: AES_ALGO, iv }, key, cipherBuf);
    return new TextDecoder().decode(plainBuf);
  }

  /**
   * Remove the shared key for a peer (e.g., on disconnect).
   * @param {string} peerId
   */
  removeSharedKey(peerId) {
    this._sharedKeys.delete(peerId);
  }

  /** @returns {boolean} */
  isInitialized() { return this._keyPair !== null; }

  /** @returns {boolean} */
  hasSharedKey(peerId) { return this._sharedKeys.has(peerId); }
}

export default E2ECrypto;
