/**
 * Tests for VectorClock
 */

import { VectorClock } from '../src/sync/vector-clock.js';

describe('VectorClock', () => {
  test('initializes with local peer at 0', () => {
    const vc = new VectorClock('A');
    expect(vc.toJSON()).toEqual({ A: 0 });
  });

  test('tick increments local counter', () => {
    const vc = new VectorClock('A');
    vc.tick();
    expect(vc.toJSON().A).toBe(1);
    vc.tick();
    expect(vc.toJSON().A).toBe(2);
  });

  test('merge takes component-wise max', () => {
    const vc = new VectorClock('A', { A: 3, B: 1 });
    vc.merge({ A: 2, B: 5, C: 1 });
    const j = vc.toJSON();
    expect(j.A).toBe(3);
    expect(j.B).toBe(5);
    expect(j.C).toBe(1);
  });

  test('compare: equal clocks', () => {
    const a = new VectorClock('A', { A: 1, B: 2 });
    const b = new VectorClock('B', { A: 1, B: 2 });
    expect(a.compare(b)).toBe('equal');
  });

  test('compare: before', () => {
    const a = new VectorClock('A', { A: 1, B: 1 });
    const b = new VectorClock('B', { A: 1, B: 2 });
    expect(a.compare(b)).toBe('before');
  });

  test('compare: after', () => {
    const a = new VectorClock('A', { A: 2, B: 1 });
    const b = new VectorClock('B', { A: 1, B: 1 });
    expect(a.compare(b)).toBe('after');
  });

  test('compare: concurrent', () => {
    const a = new VectorClock('A', { A: 2, B: 1 });
    const b = new VectorClock('B', { A: 1, B: 2 });
    expect(a.compare(b)).toBe('concurrent');
  });

  test('fromJSON/toJSON round-trip', () => {
    const vc = new VectorClock('X', { X: 5, Y: 3 });
    const restored = VectorClock.fromJSON('X', vc.toJSON());
    expect(restored.toJSON()).toEqual({ X: 5, Y: 3 });
  });

  test('compare works with plain objects', () => {
    const a = new VectorClock('A', { A: 1 });
    expect(a.compare({ A: 2 })).toBe('before');
  });
});
