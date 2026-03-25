import { EventBus } from '../event-bus.js';

export interface LWWState<T = unknown> {
  value: T | null;
  timestamp: number;
  writerId: string | null;
}

/**
 * LWWRegister — Last-Writer-Wins Register (Lamport timestamp, peerId tie-break).
 */
export declare class LWWRegister<T = unknown> extends EventBus {
  constructor(peerId: string);

  readonly value: T | null;
  readonly timestamp: number;
  readonly writerId: string | null;

  set(value: T): this;
  merge(remote: LWWState<T>): this;
  toJSON(): LWWState<T>;

  static fromJSON<T>(peerId: string, state: LWWState<T>): LWWRegister<T>;
}

/** ── ORSet ──────────────────────────────────────────────────────────── */

export interface ORSetState {
  add: Record<string, number>;
  remove: Record<string, number>;
}

/**
 * ORSet — Observed-Remove Set CRDT.
 * Each element carries a unique tag so concurrent add+remove is resolved correctly.
 */
export declare class ORSet extends EventBus {
  constructor(peerId: string);

  add(element: string): this;
  remove(element: string): this;
  has(element: string): boolean;
  values(): string[];
  merge(remote: ORSetState): this;
  toJSON(): ORSetState;

  static fromJSON(peerId: string, state: ORSetState): ORSet;
}

/** ── GCounter ───────────────────────────────────────────────────────── */

export interface GCounterState {
  counts: Record<string, number>;
}

/**
 * GCounter — Grow-only counter CRDT.
 * Each peer has its own shard; the total is the sum of all shards.
 */
export declare class GCounter extends EventBus {
  constructor(peerId: string);

  increment(amount?: number): this;
  value(): number;
  merge(remote: GCounterState): this;
  toJSON(): GCounterState;

  static fromJSON(peerId: string, state: GCounterState): GCounter;
}

/** ── CRDTManager ───────────────────────────────────────────────────── */

/**
 * CRDTManager — registry and network-sync helper for CRDT instances.
 *
 * Events emitted:
 *   'crdt:updated' ({ key, type, value })
 */
export declare class CRDTManager extends EventBus {
  constructor(opts: {
    router: import('./message-router.js').MessageRouter;
    peerId: string;
  });

  /** Register or retrieve an LWWRegister by key. */
  getLWW<T = unknown>(key: string): LWWRegister<T>;

  /** Register or retrieve an ORSet by key. */
  getORSet(key: string): ORSet;

  /** Register or retrieve a GCounter by key. */
  getGCounter(key: string): GCounter;

  /** Merge a remote CRDT state delta received from a peer. */
  merge(key: string, type: 'lww' | 'orset' | 'gcounter', state: unknown): void;
}
