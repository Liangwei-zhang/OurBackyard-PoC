import { IStorage, StorageRecord, GetAllOptions } from './storage-interface.js';

/** In-memory IStorage implementation backed by a Map. Useful for tests. */
export declare class MemoryStorage extends IStorage {
  put(key: string, value: unknown): Promise<void>;
  get<T = unknown>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  getAll(opts?: GetAllOptions): Promise<StorageRecord[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}
