export interface StorageRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

export interface GetAllOptions {
  /** Return only records with updatedAt >= since (milliseconds epoch). */
  since?: number;
}

/**
 * IStorage — abstract key-value storage contract.
 * All methods return Promises.
 */
export declare class IStorage {
  put(key: string, value: unknown): Promise<void>;
  get<T = unknown>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  getAll(opts?: GetAllOptions): Promise<StorageRecord[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}
