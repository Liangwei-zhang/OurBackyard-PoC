import { IStorage, StorageRecord, GetAllOptions } from './storage-interface.js';

/**
 * IndexedDBStorage — persistent IStorage backed by the browser's IndexedDB.
 *
 * Schema: database `ob_sdk_<dbName>`, object store `kv`:
 *   - `key`       string (keyPath)
 *   - `value`     any
 *   - `updatedAt` number (indexed for delta-sync efficiency)
 *
 * Falls back gracefully: callers should catch errors on `_ready` and use
 * MemoryStorage as a fallback when IndexedDB is unavailable (e.g. Node.js).
 */
export declare class IndexedDBStorage extends IStorage {
  /** Resolves once the database is open and ready. Await before first use. */
  readonly _ready: Promise<IDBDatabase>;

  constructor(dbName?: string, version?: number);

  put(key: string, value: unknown): Promise<void>;
  get<T = unknown>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  getAll(opts?: GetAllOptions): Promise<StorageRecord[]>;
  count(): Promise<number>;
  clear(): Promise<void>;

  /**
   * Return all records whose key starts with `prefix`.
   * Uses IDBKeyRange.bound for O(log n) prefix scan.
   * Pass empty string to return all records.
   */
  getByPrefix(prefix: string): Promise<StorageRecord[]>;

  /**
   * Atomically read–modify–write a key.
   * The callback receives the current value (or null) and should return the new value.
   * @returns Resolves with the new value written.
   */
  update<T = unknown>(key: string, cb: (current: T | null) => T | Promise<T>): Promise<T>;

  /** Close the underlying database connection. */
  close(): Promise<void>;

  /** Delete the entire IndexedDB database. */
  destroy(): Promise<void>;
}
