import { EventBus } from './event-bus.js';

export declare class Config extends EventBus {
  get(key: string, fallback?: any): any;
  set(key: string, value: any): void;
  reset(): void;
}

/** Global singleton Config instance. */
export declare const config: Config;

/** Default export is the Config class. */
export default Config;
