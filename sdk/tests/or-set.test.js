/**
 * Tests for ORSet
 */

import { ORSet } from '../src/crdt/or-set.js';

describe('ORSet', () => {
  test('empty set has no elements', () => {
    const s = new ORSet('A');
    expect(s.values().size).toBe(0);
  });

  test('add elements', () => {
    const s = new ORSet('A');
    s.add('apple');
    s.add('banana');
    expect(s.has('apple')).toBe(true);
    expect(s.has('banana')).toBe(true);
    expect(s.has('cherry')).toBe(false);
  });

  test('remove element', () => {
    const s = new ORSet('A');
    s.add('apple');
    s.remove('apple');
    expect(s.has('apple')).toBe(false);
  });

  test('values() returns current elements', () => {
    const s = new ORSet('A');
    s.add('x');
    s.add('y');
    s.remove('x');
    const vals = s.values();
    expect(vals.has('y')).toBe(true);
    expect(vals.has('x')).toBe(false);
  });

  test('merge: add-wins on concurrent add/remove', () => {
    // Peer A adds 'item', Peer B concurrently removes it (from a snapshot without A's tag)
    const a = new ORSet('A');
    a.add('item');
    const snap = a.toJSON();

    const b = new ORSet('B');
    b.merge(snap);
    b.remove('item'); // B removes the item using A's tags

    // A adds again concurrently (new tag)
    const a2 = new ORSet('A');
    a2.merge(snap);
    a2.add('item'); // new unique tag

    // Merge both sides
    a2.merge(b.toJSON());
    // A's second add should survive (add-wins semantics)
    expect(a2.has('item')).toBe(true);
  });

  test('merge is idempotent', () => {
    const a = new ORSet('A');
    a.add('x');
    const snap = a.toJSON();
    const b = new ORSet('B');
    b.merge(snap);
    b.merge(snap);
    expect(b.has('x')).toBe(true);
    expect(b.values().size).toBe(1);
  });

  test('toJSON / fromJSON round-trip', () => {
    const s = new ORSet('A');
    s.add('foo');
    s.add('bar');
    s.remove('foo');
    const json = s.toJSON();
    const restored = ORSet.fromJSON('A', json);
    expect(restored.has('bar')).toBe(true);
    expect(restored.has('foo')).toBe(false);
  });

  test('handles object elements via JSON stringify', () => {
    const s = new ORSet('A');
    s.add({ id: 1 });
    expect(s.has({ id: 1 })).toBe(true);
    expect(s.has({ id: 2 })).toBe(false);
  });
});
