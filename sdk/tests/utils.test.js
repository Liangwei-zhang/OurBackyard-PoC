/**
 * Tests for utils (uuid, sha256hex, ab2hex, hex2ab)
 * Run with: node --test sdk/tests/utils.test.js
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { uuid, sha256hex, ab2hex, hex2ab } from '../src/utils.js';

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

describe('uuid()', () => {
  it('returns a string matching UUID v4 format', () => {
    const id = uuid();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, uuid));
    assert.equal(ids.size, 100);
  });
});

describe('ab2hex() / hex2ab()', () => {
  it('roundtrip: ab2hex → hex2ab', () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const hex = ab2hex(original.buffer);
    assert.equal(hex, 'deadbeef');
    const back = new Uint8Array(hex2ab(hex));
    assert.deepEqual(back, original);
  });

  it('ab2hex handles Uint8Array directly', () => {
    const bytes = new Uint8Array([0x00, 0xff]);
    assert.equal(ab2hex(bytes), '00ff');
  });

  it('hex2ab throws on odd-length hex', () => {
    assert.throws(() => hex2ab('abc'), RangeError);
  });

  it('empty buffer roundtrip', () => {
    assert.equal(ab2hex(new ArrayBuffer(0)), '');
    const buf = hex2ab('');
    assert.equal(buf.byteLength, 0);
  });
});

describe('sha256hex()', () => {
  it('returns 64-char hex string', async () => {
    const h = await sha256hex('hello');
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('same input → same hash', async () => {
    const h1 = await sha256hex('test');
    const h2 = await sha256hex('test');
    assert.equal(h1, h2);
  });

  it('different input → different hash', async () => {
    const h1 = await sha256hex('foo');
    const h2 = await sha256hex('bar');
    assert.notEqual(h1, h2);
  });

  it('known SHA-256 of empty string', async () => {
    const h = await sha256hex('');
    assert.equal(h, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
