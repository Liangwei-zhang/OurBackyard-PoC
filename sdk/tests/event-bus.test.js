import { EventBus } from '../src/event-bus.js';

describe('EventBus', () => {
  let bus;
  beforeEach(() => { bus = new EventBus(); });

  test('on() / emit() — persistent listener called multiple times', () => {
    const calls = [];
    bus.on('foo', d => calls.push(d));
    bus.emit('foo', 1);
    bus.emit('foo', 2);
    expect(calls).toEqual([1, 2]);
  });

  test('once() fires exactly once', () => {
    const calls = [];
    bus.once('bar', d => calls.push(d));
    bus.emit('bar', 'a');
    bus.emit('bar', 'b');
    expect(calls).toEqual(['a']);
  });

  test('off() removes persistent listener', () => {
    const calls = [];
    const fn = d => calls.push(d);
    bus.on('baz', fn);
    bus.off('baz', fn);
    bus.emit('baz', 1);
    expect(calls).toHaveLength(0);
  });

  test('off() removes once listener before it fires', () => {
    const calls = [];
    const fn = d => calls.push(d);
    bus.once('qux', fn);
    bus.off('qux', fn);
    bus.emit('qux', 1);
    expect(calls).toHaveLength(0);
  });

  test('removeAllListeners(event) clears that event only', () => {
    const a = []; const b = [];
    bus.on('a', d => a.push(d));
    bus.on('b', d => b.push(d));
    bus.removeAllListeners('a');
    bus.emit('a', 1);
    bus.emit('b', 2);
    expect(a).toHaveLength(0);
    expect(b).toEqual([2]);
  });

  test('removeAllListeners() with no arg clears everything', () => {
    const calls = [];
    bus.on('x', d => calls.push(d));
    bus.once('y', d => calls.push(d));
    bus.removeAllListeners();
    bus.emit('x', 1);
    bus.emit('y', 2);
    expect(calls).toHaveLength(0);
  });

  test('listenerCount() counts persistent + once', () => {
    bus.on('evt', () => {});
    bus.once('evt', () => {});
    expect(bus.listenerCount('evt')).toBe(2);
    bus.emit('evt');
    expect(bus.listenerCount('evt')).toBe(1); // once removed
  });

  test('emit() returns true when listeners exist', () => {
    bus.on('z', () => {});
    expect(bus.emit('z', null)).toBe(true);
  });

  test('emit() returns false when no listeners', () => {
    expect(bus.emit('nope', null)).toBe(false);
  });

  test('on() throws for non-string event', () => {
    expect(() => bus.on(42, () => {})).toThrow(TypeError);
  });

  test('on() throws for non-function listener', () => {
    expect(() => bus.on('evt', 'not-a-function')).toThrow(TypeError);
  });

  test('listener errors are isolated — other listeners still fire', () => {
    const calls = [];
    bus.on('err', () => { throw new Error('oops'); });
    bus.on('err', d => calls.push(d));
    bus.emit('err', 42);
    expect(calls).toEqual([42]);
  });
});
