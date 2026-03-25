/**
 * Signature — ECDSA P-256 message signing and verification.
 */
export declare class Signature {
  constructor();

  /** Generate a new ECDSA key pair. */
  init(): Promise<void>;

  /** Returns the ECDSA public key as a JWK string. */
  getPublicKeyJWK(): string;

  /** Sign a message string. Returns hex-encoded DER signature. */
  sign(message: string): Promise<string>;

  /**
   * Verify a signature.
   * @param message - The original message string
   * @param sigHex - Hex-encoded DER signature
   * @param publicKeyJWK - Signer's ECDSA public key as JWK string
   */
  verify(message: string, sigHex: string, publicKeyJWK: string): Promise<boolean>;
}
