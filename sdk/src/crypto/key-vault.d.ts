import { EventBus } from '../event-bus.js';

/**
 * KeyVault — Secure in-memory CryptoKey store with import/export helpers.
 *
 * Events: 'key:generated' ({ alias, type }), 'key:imported' ({ alias })
 */
export declare class KeyVault extends EventBus {
  constructor();

  /** Generate and store an ECDH P-256 key pair under `alias`. */
  generateECDH(alias: string): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }>;

  /** Generate and store an ECDSA P-256 key pair under `alias`. */
  generateECDSA(alias: string): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }>;

  /** Retrieve a stored key by alias and role. */
  get(alias: string, role: 'pub' | 'priv'): CryptoKey | undefined;

  /** Export a stored key to JWK format. */
  exportJWK(alias: string, role: 'pub' | 'priv'): Promise<JsonWebKey>;

  /** Import a JWK and store it under alias. */
  importJWK(alias: string, role: 'pub' | 'priv', jwk: JsonWebKey, algorithm: AlgorithmIdentifier, keyUsages: KeyUsage[]): Promise<CryptoKey>;

  /** Check whether a key pair exists for the given alias. */
  has(alias: string): boolean;

  /** Delete all keys associated with an alias. */
  remove(alias: string): void;
}
