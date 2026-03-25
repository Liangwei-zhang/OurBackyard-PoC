import { Logger, LogLevel } from '../src/logger.js';

describe('Logger', () => {
  test('does not output below configured level', () => {
    const calls = { debug: [], info: [], warn: [], error: [] };
    const out = {
      debug: (...a) => calls.debug.push(a),
      info: (...a) => calls.info.push(a),
      warn: (...a) => calls.warn.push(a),
      error: (...a) => calls.error.push(a),
    };
    const log = new Logger('TEST', { level: LogLevel.WARN, output: out });
    log.debug('should not appear');
    log.info('should not appear');
    log.warn('this should');
    log.error('this should');
    expect(calls.debug).toHaveLength(0);
    expect(calls.info).toHaveLength(0);
    expect(calls.warn).toHaveLength(1);
    expect(calls.error).toHaveLength(1);
  });

  test('outputs all levels at DEBUG', () => {
    const calls = [];
    const out = { debug: (...a) => calls.push(a), info: (...a) => calls.push(a), warn: (...a) => calls.push(a), error: (...a) => calls.push(a) };
    const log = new Logger('T', { level: LogLevel.DEBUG, output: out });
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(calls).toHaveLength(4);
  });

  test('module tag prepended to output', () => {
    const calls = [];
    const out = { info: (...a) => calls.push(a), debug: ()=>{}, warn: ()=>{}, error: ()=>{} };
    const log = new Logger('MyModule', { level: LogLevel.DEBUG, output: out });
    log.info('hello');
    expect(calls[0][0]).toBe('[MyModule]');
    expect(calls[0][1]).toBe('hello');
  });

  test('child() creates sub-module logger', () => {
    const calls = [];
    const out = { info: (...a) => calls.push(a), debug: ()=>{}, warn: ()=>{}, error: ()=>{} };
    const parent = new Logger('Parent', { level: LogLevel.DEBUG, output: out });
    const child = parent.child('Child');
    child.info('msg');
    expect(calls[0][0]).toBe('[Parent:Child]');
  });

  test('NONE level suppresses all output', () => {
    const calls = [];
    const out = { debug: (...a) => calls.push(a), info: (...a) => calls.push(a), warn: (...a) => calls.push(a), error: (...a) => calls.push(a) };
    const log = new Logger('T', { level: LogLevel.NONE, output: out });
    log.debug('x'); log.info('x'); log.warn('x'); log.error('x');
    expect(calls).toHaveLength(0);
  });

  test('setLevel() changes level at runtime', () => {
    const calls = [];
    const out = { debug: (...a) => calls.push(a), info: ()=>{}, warn: ()=>{}, error: ()=>{} };
    const log = new Logger('T', { level: LogLevel.INFO, output: out });
    log.debug('no'); // INFO level — debug suppressed
    log.setLevel(LogLevel.DEBUG);
    log.debug('yes');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('yes');
  });
});
