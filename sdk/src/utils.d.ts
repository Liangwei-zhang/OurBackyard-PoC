/** Generate a RFC-4122 v4 UUID. */
export declare function uuid(): string;

/** Convert ArrayBuffer / Uint8Array to lowercase hex string. */
export declare function ab2hex(ab: ArrayBuffer | Uint8Array): string;

/** Convert lowercase hex string to ArrayBuffer. */
export declare function hex2ab(hex: string): ArrayBuffer;

/** Compute SHA-256 of a string, return lowercase hex. */
export declare function sha256hex(text: string): Promise<string>;

/** Internal leveled log helper (module tag prepended automatically). */
export declare function log(level: 'debug' | 'info' | 'warn' | 'error', module: string, ...args: any[]): void;
