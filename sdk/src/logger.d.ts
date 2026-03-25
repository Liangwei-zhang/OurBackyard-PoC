/** Numeric log levels. */
export declare const LogLevel: {
  readonly DEBUG: 0;
  readonly INFO: 1;
  readonly WARN: 2;
  readonly ERROR: 3;
  readonly NONE: 4;
};

export declare type LogLevelValue = 0 | 1 | 2 | 3 | 4;

export declare class Logger {
  module: string;
  level: LogLevelValue;

  constructor(
    module?: string,
    opts?: {
      level?: LogLevelValue;
      output?: {
        debug: (...a: any[]) => void;
        info:  (...a: any[]) => void;
        warn:  (...a: any[]) => void;
        error: (...a: any[]) => void;
      };
    }
  );

  setLevel(level: LogLevelValue): void;
  debug(msg?: any, ...args: any[]): void;
  info(msg?: any, ...args: any[]): void;
  warn(msg?: any, ...args: any[]): void;
  error(msg?: any, ...args: any[]): void;

  /** Create a child logger prefixed with `<module>:<subModule>`. */
  child(subModule: string): Logger;
}
