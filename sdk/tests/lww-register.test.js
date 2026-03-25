/**
 * Tests for LWWRegister
 */

import { LWWRegister } from '../src/crdt/lww-register.js';

describe('LWWRegister', () => {
  test('initial value is null', () => {
    const reg = new LWWRegister('peer-A');
    expect(reg.get()).toBeNull();
  });

  test('set stores the value', () => {
    const reg = new LWWRegister('peer-A');
    reg.set('hello');
    expect(reg.get()).toBe('hello');
  });

  test('set returns operation with timestamp', () => {
    const reg = new LWWRegister('peer-A');
    const op = reg.set('world');
    expect(op.value).toBe('world');
    expect(op.peerId).toBe('peer-A');
    expect(typeof op.timestamp).toBe('number');
  });

  test('merge: higher timestamp wins', () => {
    const reg = new LWWRegister('A');
    reg.set('local');
    reg.merge({ peerId: 'B', value: 'remote', timestamp: Date.now() + 1000 });
    expect(reg.get()).toBe('remote');
  });

  test('merge: local wins if higher timestamp', () => {
    const reg = new LWWRegister('A');
    const op = reg.set('local');
    reg.merge({ peerId: 'B', value: 'remote', timestamp: op.timestamp - 1 });
    expect(reg.get()).toBe('local');
  });

  test('merge: tie-break by peerId', () => {
    const reg = new LWWRegister('A');
    const ts = Date.now();
    reg.merge({ peerId: 'A', value: 'from-A', timestamp: ts });
    reg.merge({ peerId: 'Z', value: 'from-Z', timestamp: ts });
    // 'Z' > 'A' lexicographically
    expect(reg.get()).toBe('from-Z');
  });

  test('merge ignores invalid remote', () => {
    const reg = new LWWRegister('A');
    reg.set('local');
    reg.merge(null);
    reg.merge({ peerId: 'B', value: 'bad' }); // no timestamp
    expect(reg.get()).toBe('local');
  });

  test('toJSON / fromJSON round-trip', () => {
    const reg = new LWWRegister('A');
    reg.set('test-value');
    const json = reg.toJSON();
    const restored = LWWRegister.fromJSON('A', json);
    expect(restored.get()).toBe('test-value');
  });
});
