/**
 * E2ECrypto — End-to-end encryption for peer-to-peer messages.
 *
 * Extracted from p2p-mesh.js ECDH key exchange + AES-GCM encrypt/decrypt.
 *
 * Flow:
 *   1. init()             — generate ECDH P-256 key pair
 *   2. getPublicKeyHex()  — share with remote peer (via signaling announce or DataChannel)
 *   3. deriveSharedKey()  — import their public key + ECDH → AES-GCM 256 shared key
 *   4. encrypt() / decrypt()
 *
 * Events emitted:
 *   'key:derived' (peerId)  — shared key ready; drain any pending messages
 */

import { EventBus } from '../event-bus.js';
import { ab2hex, hex2ab } from '../utils.js';

export class E2ECrypto extends EventBus {
  constructor() {
    super();
    /** @type {CryptoKey|null} */
    this._privateKey = null;
    /** @type {ArrayBuffer|null} */
    this._publicKeyRaw = null;
    /** @type {Map<string, CryptoKey>} peerId → AES-GCM key */
    this._sharedKeys = new Map();
  }

  // ─────────────────────────── Public API ───────────────────────────

  /**
   * Generate a fresh ECDH P-256 key pair.
   * Must be called once before any encrypt/decrypt operations.
   */
  async init() {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
    this._privateKey   = pair.privateKey;
    this._publicKeyRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
  }

  /**
   * Returns this node's ECDH public key as a lowercase hex string.
   * Share this with remote peers so they can derive the shared key.
   * @returns {string}
   */
  getPublicKeyHex() {
    if (!this._publicKeyRaw) throw new Error('E2ECrypto not initialised — call init() first');
    return ab2hex(this._publicKeyRaw);
  }

  /**
   * Derive a shared AES-GCM key from a peer's ECDH public key (hex-encoded).
   * Emits 'key:derived' (peerId) once ready.
   * @param {string} peerId
   * @param {string} theirPublicKeyHex
   * @returns {Promise<CryptoKey|null>}
   */
  async deriveSharedKey(peerId, theirPublicKeyHex) {
    if (this._sharedKeys.has(peerId)) return this._sharedKeys.get(peerId);
    if (!this._privateKey) return null;

    try {
      const rawKey  = hex2ab(theirPublicKeyHex);
      const pubKey  = await crypto.subtle.importKey(
        'raw', rawKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []
      );
      const shared  = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: pubKey },
        this._privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      this._sharedKeys.set(peerId, shared);
      this.emit('key:derived', peerId);
      return shared;
    } catch (e) {
      console.warn('[E2ECrypto] deriveSharedKey failed for', peerId, e.message);
      return null;
    }
  }

  /**
   * Whether a shared key exists for the given peer.
   * @param {string} peerId
   * @returns {boolean}
   */
  hasKey(peerId) {
    return this._sharedKeys.has(peerId);
  }

  /**
   * Encrypt a plaintext string for a specific peer.
   * Returns a serialisable envelope or the plain object if no key exists yet.
   * @param {string} peerId
   * @param {string|object} plaintext — will be JSON-stringified if not a string
   * @returns {Promise<{iv:string, ciphertext:string, encrypted:true}|object>}
   */
  async encrypt(peerId, plaintext) {
    const key = this._sharedKeys.get(peerId);
    if (!key) {
      console.warn(`[E2ECrypto] No shared key for ${peerId} — message will be sent as plaintext`);
      return plaintext; // graceful fallback: key exchange still in progress
    }

    const iv         = crypto.getRandomValues(new Uint8Array(12));
    const encoded    = new TextEncoder().encode(
      typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext)
    );
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

    return {
      iv:         ab2hex(iv),
      ciphertext: ab2hex(ciphertext),
      encrypted:  true,
    };
  }

  /**
   * Decrypt an encrypted envelope from a specific peer.
   * If the payload is not encrypted (no .encrypted flag), returns it as-is.
   * @param {string} peerId
   * @param {object} envelope
   * @returns {Promise<string>} — decrypted plaintext string
   */
  async decrypt(peerId, envelope) {
    if (!envelope?.encrypted) return envelope; // plaintext passthrough

    const key = this._sharedKeys.get(peerId);
    if (!key) {
      throw new Error('No shared key for peer: ' + peerId);
    }

    const iv         = hex2ab(envelope.iv);
    const ciphertext = hex2ab(envelope.ciphertext);
    const plaintext  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  }
}
