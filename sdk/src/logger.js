/**
 * @file logger.js
 * @description Leveled logger (debug/info/warn/error) with configurable output and module tagging.
 * Zero external dependencies.
 */

export const LogLevel = Object.freeze({ DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 });

export class Logger {
  /**
   * @param {string} module - Module tag printed with every log line
   * @param {{ level?: number, output?: { debug: Function, info: Function, warn: Function, error: Function } }} [opts]
   */
  constructor(module = 'SDK', opts = {}) {
    this.module = module;
    this.level = opts.level ?? LogLevel.INFO;
    this._out = opts.output ?? {
      debug: console.debug.bind(console),
      info:  console.info.bind(console),
      warn:  console.warn.bind(console),
      error: console.error.bind(console),
    };
  }

  /** @param {number} level */
  setLevel(level) { this.level = level; }

  /** @param {string} [msg] @param {...*} args */
  debug(msg, ...args) { if (this.level <= LogLevel.DEBUG) this._out.debug(`[${this.module}]`, msg, ...args); }
  info(msg, ...args)  { if (this.level <= LogLevel.INFO)  this._out.info(`[${this.module}]`, msg, ...args); }
  warn(msg, ...args)  { if (this.level <= LogLevel.WARN)  this._out.warn(`[${this.module}]`, msg, ...args); }
  error(msg, ...args) { if (this.level <= LogLevel.ERROR) this._out.error(`[${this.module}]`, msg, ...args); }

  /**
   * Create a child logger with a sub-module tag.
   * @param {string} subModule
   * @returns {Logger}
   */
  child(subModule) {
    return new Logger(`${this.module}:${subModule}`, { level: this.level, output: this._out });
  }
}

/** Default logger instance for the SDK */
export const defaultLogger = new Logger('P2PSDK');

export default Logger;
