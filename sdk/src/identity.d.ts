import { EventBus } from '../event-bus.js';

export interface IdentityRecord {
  id: string;
  publicKeyJWK: string;
  signingKeyJWK: string;
  createdAt: number;
}

/**
 * Identity — DID-like identity with ECDH + ECDSA key pairs.
 *
 * Events: 'identity:created', 'identity:loaded', 'identity:reset'
 */
export declare class Identity extends EventBus {
  constructor();

  /**
   * Load persisted identity from localStorage or generate a fresh one.
   */
  init(): Promise<IdentityRecord>;

  /** Return the current identity. Throws if not initialized. */
  get(): IdentityRecord;

  /** DID-like identifier derived from the ECDH public key. */
  readonly id: string;

  /** In-memory ECDH private key (ephemeral; lost on reload). */
  readonly ecdhPrivateKey: CryptoKey | null;

  /** In-memory ECDSA private key (ephemeral; lost on reload). */
  readonly ecdsaPrivateKey: CryptoKey | null;

  /** Export the public identity bundle as a JSON string. */
  export(): string;

  /** Clear persisted identity and reset in-memory state. */
  reset(): void;

  /** Whether init() has been called successfully. */
  readonly isInitialized: boolean;
}
