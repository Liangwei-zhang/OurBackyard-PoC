import { EventBus } from '../event-bus.js';

/**
 * E2ECrypto — End-to-end encryption via ECDH P-256 + AES-GCM.
 *
 * Events: 'key:derived' (peerId: string)
 */
export declare class E2ECrypto extends EventBus {
  constructor();

  /** Generate a fresh ECDH P-256 key pair. Call before any encrypt/decrypt. */
  init(): Promise<void>;

  /** Returns this node's ECDH public key as lowercase hex. */
  getPublicKeyHex(): string;

  /**
   * Derive a shared AES-GCM key from a peer's ECDH public key (hex-encoded).
   * Emits 'key:derived' (peerId) when ready.
   */
  deriveSharedKey(peerId: string, theirPublicKeyHex: string): Promise<void>;

  /** Encrypt a plaintext string for a peer. Returns { ciphertext, iv } as hex strings. */
  encrypt(peerId: string, plaintext: string): Promise<{ ciphertext: string; iv: string }>;

  /** Decrypt a ciphertext for a peer. */
  decrypt(peerId: string, ciphertext: string, iv: string): Promise<string>;

  /** Whether a shared key has been derived for this peer. */
  hasSharedKey(peerId: string): boolean;
}
