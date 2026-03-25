/**
 * Tests for Logger — leveled logger with module tagging.
 * Run with: node --test sdk/tests/logger.test.js
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Logger, LogLevel } from '../src/logger.js';

describe('Logger', () => {
  it('does not output below configured level', () => {
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
    assert.equal(calls.debug.length, 0);
    assert.equal(calls.info.length, 0);
    assert.equal(calls.warn.length, 1);
    assert.equal(calls.error.length, 1);
  });

  it('outputs all levels at DEBUG', () => {
    const calls = [];
    const out = { debug: (...a) => calls.push(a), info: (...a) => calls.push(a), warn: (...a) => calls.push(a), error: (...a) => calls.push(a) };
    const log = new Logger('T', { level: LogLevel.DEBUG, output: out });
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    assert.equal(calls.length, 4);
  });

  it('module tag prepended to output', () => {
    const calls = [];
    const out = { info: (...a) => calls.push(a), debug: ()=>{}, warn: ()=>{}, error: ()=>{} };
    const log = new Logger('MyModule', { level: LogLevel.DEBUG, output: out });
    log.info('hello');
    assert.equal(calls[0][0], '[MyModule]');
    assert.equal(calls[0][1], 'hello');
  });

  it('child() creates sub-module logger', () => {
    const calls = [];
    const out = { info: (...a) => calls.push(a), debug: ()=>{}, warn: ()=>{}, error: ()=>{} };
    const parent = new Logger('Parent', { level: LogLevel.DEBUG, output: out });
    const child = parent.child('Child');
    child.info('msg');
    assert.equal(calls[0][0], '[Parent:Child]');
  });

  it('NONE level suppresses all output', () => {
    const calls = [];
    const out = { debug: (...a) => calls.push(a), info: (...a) => calls.push(a), warn: (...a) => calls.push(a), error: (...a) => calls.push(a) };
    const log = new Logger('T', { level: LogLevel.NONE, output: out });
    log.debug('x'); log.info('x'); log.warn('x'); log.error('x');
    assert.equal(calls.length, 0);
  });

  it('setLevel() changes level at runtime', () => {
    const calls = [];
    const out = { debug: (...a) => calls.push(a), info: ()=>{}, warn: ()=>{}, error: ()=>{} };
    const log = new Logger('T', { level: LogLevel.INFO, output: out });
    log.debug('no');
    log.setLevel(LogLevel.DEBUG);
    log.debug('yes');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'yes');
  });
});

describe('Logger — advanced', () => {
  it('INFO level suppresses debug only', () => {
    const calls = { debug: [], info: [], warn: [], error: [] };
    const out = {
      debug: (...a) => calls.debug.push(a),
      info: (...a) => calls.info.push(a),
      warn: (...a) => calls.warn.push(a),
      error: (...a) => calls.error.push(a),
    };
    const log = new Logger('T', { level: LogLevel.INFO, output: out });
    log.debug('no'); log.info('yes'); log.warn('yes'); log.error('yes');
    assert.equal(calls.debug.length, 0);
    assert.equal(calls.info.length, 1);
    assert.equal(calls.warn.length, 1);
    assert.equal(calls.error.length, 1);
  });

  it('ERROR level only logs errors', () => {
    const calls = [];
    const out = { debug: ()=>{}, info: ()=>{}, warn: ()=>{}, error: (...a) => calls.push(a) };
    const log = new Logger('T', { level: LogLevel.ERROR, output: out });
    log.debug('x'); log.info('x'); log.warn('x'); log.error('only-this');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'only-this');
  });

  it('multiple args are forwarded to output', () => {
    const calls = [];
    const out = { info: (...a) => calls.push(a), debug: ()=>{}, warn: ()=>{}, error: ()=>{} };
    const log = new Logger('T', { level: LogLevel.DEBUG, output: out });
    log.info('msg', { foo: 'bar' }, 42);
    assert.equal(calls[0][1], 'msg');
    assert.deepEqual(calls[0][2], { foo: 'bar' });
    assert.equal(calls[0][3], 42);
  });

  it('LogLevel values are ordered: DEBUG < INFO < WARN < ERROR < NONE', () => {
    assert.ok(LogLevel.DEBUG < LogLevel.INFO);
    assert.ok(LogLevel.INFO < LogLevel.WARN);
    assert.ok(LogLevel.WARN < LogLevel.ERROR);
    assert.ok(LogLevel.ERROR < LogLevel.NONE);
  });
});
