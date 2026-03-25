/**
 * EventBus — Tiny typed in-process EventEmitter.
 * Base class for all SDK modules.
 */
export declare class EventBus {
  on(event: string, fn: (...args: any[]) => void): this;
  off(event: string, fn: (...args: any[]) => void): this;
  once(event: string, fn: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): void;
  removeAllListeners(event?: string): void;
}
