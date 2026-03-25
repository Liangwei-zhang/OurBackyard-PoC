/**
 * Tests for MerkleTree
 */

import { MerkleTree } from '../src/sync/merkle-tree.js';

// Use a simple hash function for testing to avoid Web Crypto dependency
const testHash = async (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

describe('MerkleTree', () => {
  test('empty tree has empty root hash', async () => {
    const t = new MerkleTree(testHash);
    await t.build([]);
    expect(t.getRootHash()).toBe('');
  });

  test('single entry tree has root = leaf hash', async () => {
    const t = new MerkleTree(testHash);
    await t.build([{ key: 'a', hash: 'aaa' }]);
    expect(t.getRootHash()).toBe('aaa');
  });

  test('two entries produce a combined root', async () => {
    const t = new MerkleTree(testHash);
    await t.build([
      { key: 'a', hash: 'aaa' },
      { key: 'b', hash: 'bbb' },
    ]);
    const expectedRoot = await testHash('aaabbb');
    expect(t.getRootHash()).toBe(expectedRoot);
  });

  test('build sorts entries by key', async () => {
    const t = new MerkleTree(testHash);
    await t.build([
      { key: 'z', hash: 'zzz' },
      { key: 'a', hash: 'aaa' },
    ]);
    expect(t.getLeafKeys()).toEqual(['a', 'z']);
  });

  test('identical builds produce same root', async () => {
    const t1 = new MerkleTree(testHash);
    const t2 = new MerkleTree(testHash);
    const entries = [
      { key: 'a', hash: 'aaa' },
      { key: 'b', hash: 'bbb' },
      { key: 'c', hash: 'ccc' },
    ];
    await t1.build(entries);
    await t2.build([...entries].reverse());
    expect(t1.getRootHash()).toBe(t2.getRootHash());
  });

  test('diff: same trees → empty diff', async () => {
    const t1 = new MerkleTree(testHash);
    const t2 = new MerkleTree(testHash);
    const entries = [{ key: 'x', hash: 'xxx' }];
    await t1.build(entries);
    await t2.build(entries);
    const diff = await MerkleTree.diff(t1, t2);
    expect(diff).toHaveLength(0);
  });

  test('diff: detects changed entry', async () => {
    const t1 = new MerkleTree(testHash);
    const t2 = new MerkleTree(testHash);
    await t1.build([{ key: 'a', hash: 'aaa' }]);
    await t2.build([{ key: 'a', hash: 'CHANGED' }]);
    const diff = await MerkleTree.diff(t1, t2);
    expect(diff).toContain('a');
  });

  test('diff: detects missing entry', async () => {
    const t1 = new MerkleTree(testHash);
    const t2 = new MerkleTree(testHash);
    await t1.build([{ key: 'a', hash: 'aaa' }, { key: 'b', hash: 'bbb' }]);
    await t2.build([{ key: 'a', hash: 'aaa' }]);
    const diff = await MerkleTree.diff(t1, t2);
    expect(diff).toContain('b');
  });

  test('insert updates the tree', async () => {
    const t = new MerkleTree(testHash);
    await t.build([{ key: 'a', hash: 'aaa' }]);
    const rootBefore = t.getRootHash();
    await t.insert('b', 'bbb');
    expect(t.getRootHash()).not.toBe(rootBefore);
    expect(t.getLeafKeys()).toContain('b');
  });

  test('insert overwrites existing key', async () => {
    const t = new MerkleTree(testHash);
    await t.build([{ key: 'a', hash: 'old' }]);
    await t.insert('a', 'new');
    expect(t.getLevel(0)).toContain('new');
    expect(t.getLevel(0)).not.toContain('old');
  });

  test('getLevel returns correct hashes', async () => {
    const t = new MerkleTree(testHash);
    await t.build([
      { key: 'a', hash: 'aaa' },
      { key: 'b', hash: 'bbb' },
    ]);
    expect(t.getLevel(0)).toEqual(['aaa', 'bbb']);
    expect(t.getLevel(1)).toHaveLength(1); // root
  });
});
