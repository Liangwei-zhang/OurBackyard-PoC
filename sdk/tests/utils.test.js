import { uuid, sha256hex, ab2hex, hex2ab } from '../src/utils.js';

// Node.js 18+ has globalThis.crypto
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

describe('uuid()', () => {
  test('returns a string matching UUID v4 format', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, uuid));
    expect(ids.size).toBe(100);
  });
});

describe('ab2hex() / hex2ab()', () => {
  test('roundtrip: ab2hex → hex2ab', () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const hex = ab2hex(original.buffer);
    expect(hex).toBe('deadbeef');
    const back = new Uint8Array(hex2ab(hex));
    expect(back).toEqual(original);
  });

  test('ab2hex handles Uint8Array directly', () => {
    const bytes = new Uint8Array([0x00, 0xff]);
    expect(ab2hex(bytes)).toBe('00ff');
  });

  test('hex2ab throws on odd-length hex', () => {
    expect(() => hex2ab('abc')).toThrow(RangeError);
  });

  test('empty buffer roundtrip', () => {
    expect(ab2hex(new ArrayBuffer(0))).toBe('');
    const buf = hex2ab('');
    expect(buf.byteLength).toBe(0);
  });
});

describe('sha256hex()', () => {
  test('returns 64-char hex string', async () => {
    const h = await sha256hex('hello');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  test('same input → same hash', async () => {
    const h1 = await sha256hex('test');
    const h2 = await sha256hex('test');
    expect(h1).toBe(h2);
  });

  test('different input → different hash', async () => {
    const h1 = await sha256hex('foo');
    const h2 = await sha256hex('bar');
    expect(h1).not.toBe(h2);
  });

  test('known SHA-256 of empty string', async () => {
    const h = await sha256hex('');
    expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
