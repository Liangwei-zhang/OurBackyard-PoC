/**
 * Tests for EventBus
 * Run with: node --test sdk/tests/event-bus.test.js
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { EventBus } from '../src/event-bus.js';

describe('EventBus', () => {
  let bus;
  beforeEach(() => { bus = new EventBus(); });

  it('on() / emit() — persistent listener called multiple times', () => {
    const calls = [];
    bus.on('foo', d => calls.push(d));
    bus.emit('foo', 1);
    bus.emit('foo', 2);
    assert.deepEqual(calls, [1, 2]);
  });

  it('once() fires exactly once', () => {
    const calls = [];
    bus.once('bar', d => calls.push(d));
    bus.emit('bar', 'a');
    bus.emit('bar', 'b');
    assert.deepEqual(calls, ['a']);
  });

  it('off() removes persistent listener', () => {
    const calls = [];
    const fn = d => calls.push(d);
    bus.on('baz', fn);
    bus.off('baz', fn);
    bus.emit('baz', 1);
    assert.equal(calls.length, 0);
  });

  it('removeAllListeners(event) clears that event only', () => {
    const a = []; const b = [];
    bus.on('a', d => a.push(d));
    bus.on('b', d => b.push(d));
    bus.removeAllListeners('a');
    bus.emit('a', 1);
    bus.emit('b', 2);
    assert.equal(a.length, 0);
    assert.deepEqual(b, [2]);
  });

  it('removeAllListeners() with no arg clears everything', () => {
    const calls = [];
    bus.on('x', d => calls.push(d));
    bus.removeAllListeners();
    bus.emit('x', 1);
    assert.equal(calls.length, 0);
  });

  it('multiple listeners on same event are all called', () => {
    const calls = [];
    bus.on('evt', d => calls.push('a:' + d));
    bus.on('evt', d => calls.push('b:' + d));
    bus.emit('evt', 1);
    assert.deepEqual(calls, ['a:1', 'b:1']);
  });

  it('on() returns this for chaining', () => {
    const result = bus.on('x', () => {});
    assert.strictEqual(result, bus);
  });

  it('off() on non-existent listener is a no-op', () => {
    assert.doesNotThrow(() => bus.off('noEvent', () => {}));
  });

  it('emit() on event with no listeners does not throw', () => {
    assert.doesNotThrow(() => bus.emit('noListeners', 42));
  });

  it('error in listener does not prevent other listeners from running', () => {
    const calls = [];
    bus.on('err', () => { throw new Error('boom'); });
    bus.on('err', d => calls.push(d));
    bus.emit('err', 99);
    assert.deepEqual(calls, [99]);
  });
});

describe('EventBus — advanced', () => {
  let bus;
  beforeEach(() => { bus = new EventBus(); });

  it('off() returns this for chaining', () => {
    const fn = () => {};
    bus.on('x', fn);
    const result = bus.off('x', fn);
    assert.strictEqual(result, bus);
  });

  it('once() handler is not called again after firing', () => {
    const calls = [];
    bus.once('z', d => calls.push(d));
    bus.emit('z', 1);
    bus.emit('z', 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 1);
  });

  it('multiple once() on same event each fire once', () => {
    const calls = [];
    bus.once('m', d => calls.push('a:' + d));
    bus.once('m', d => calls.push('b:' + d));
    bus.emit('m', 1);
    bus.emit('m', 2);
    assert.equal(calls.length, 2);
  });

  it('on() and once() coexist on same event', () => {
    const persistent = [];
    const oneTime = [];
    bus.on('evt', d => persistent.push(d));
    bus.once('evt', d => oneTime.push(d));
    bus.emit('evt', 1);
    bus.emit('evt', 2);
    assert.deepEqual(persistent, [1, 2]);
    assert.deepEqual(oneTime, [1]);
  });

  it('removeAllListeners() followed by on() works normally', () => {
    const calls = [];
    bus.on('a', () => {});
    bus.removeAllListeners();
    bus.on('a', d => calls.push(d));
    bus.emit('a', 42);
    assert.deepEqual(calls, [42]);
  });
});
