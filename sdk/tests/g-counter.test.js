/**
 * Tests for GCounter
 */

import { GCounter } from '../src/crdt/g-counter.js';

describe('GCounter', () => {
  test('initial value is 0', () => {
    const c = new GCounter('A');
    expect(c.value()).toBe(0);
  });

  test('increment increases local counter', () => {
    const c = new GCounter('A');
    c.increment();
    expect(c.value()).toBe(1);
    c.increment(5);
    expect(c.value()).toBe(6);
  });

  test('increment throws for non-positive amount', () => {
    const c = new GCounter('A');
    expect(() => c.increment(0)).toThrow();
    expect(() => c.increment(-1)).toThrow();
  });

  test('merge sums all peers', () => {
    const a = new GCounter('A');
    const b = new GCounter('B');
    a.increment(3);
    b.increment(7);
    a.merge(b.toJSON());
    expect(a.value()).toBe(10);
  });

  test('merge is idempotent', () => {
    const a = new GCounter('A');
    a.increment(5);
    const snap = a.toJSON();
    a.merge(snap);
    a.merge(snap);
    expect(a.value()).toBe(5);
  });

  test('merge with lower values is no-op', () => {
    const a = new GCounter('A');
    a.increment(10);
    a.merge({ counts: { A: 3 } });
    expect(a.value()).toBe(10);
  });

  test('toJSON / fromJSON round-trip', () => {
    const c = new GCounter('A');
    c.increment(42);
    const json = c.toJSON();
    const restored = GCounter.fromJSON('A', json);
    expect(restored.value()).toBe(42);
  });
});
