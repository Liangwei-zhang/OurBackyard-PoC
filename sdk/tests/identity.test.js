/**
 * Tests for Identity — DID generation, persistence, restore, reset.
 * Run with: node --test sdk/tests/identity.test.js
 *
 * globalThis.localStorage is mocked so no real browser storage is required.
 * crypto.subtle is available natively in Node 18+.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import config from '../src/config.js';
import { Identity } from '../src/identity.js';

// ── Mock localStorage ─────────────────────────────────────────────────────────

const _store = new Map();
const mockLS = {
  getItem:    k => _store.get(k) ?? null,
  setItem:    (k, v) => _store.set(k, v),
  removeItem: k => _store.delete(k),
};

beforeEach(() => {
  _store.clear();
  globalThis.localStorage = mockLS;
});

// ── First-run (generate fresh identity) ──────────────────────────────────────

describe('Identity — init() first run', () => {
  it('returns an identity with a DID id', async () => {
    const ident = await new Identity().init();
    assert.ok(ident.id.startsWith('did:ob:'), `Expected DID prefix, got: ${ident.id}`);
  });

  it('returns JSON-encoded ECDH public key', async () => {
    const ident = await new Identity().init();
    const key   = JSON.parse(ident.publicKeyJWK);
    assert.equal(key.kty, 'EC');
    assert.equal(key.crv, 'P-256');
  });

  it('returns JSON-encoded ECDSA public key', async () => {
    const ident = await new Identity().init();
    const key   = JSON.parse(ident.signingKeyJWK);
    assert.equal(key.kty, 'EC');
    assert.equal(key.crv, 'P-256');
  });

  it('persists identity to localStorage', async () => {
    const storageKey = config.get('identity.storageKey');
    await new Identity().init();
    const stored = mockLS.getItem(storageKey);
    assert.ok(stored, 'Identity should be persisted to localStorage');
    const parsed = JSON.parse(stored);
    assert.ok(parsed.id.startsWith('did:ob:'));
  });

  it('emits "identity:created" event', async () => {
    const id     = new Identity();
    const events = [];
    id.on('identity:created', e => events.push(e));
    await id.init();
    assert.equal(events.length, 1);
    assert.ok(events[0].id.startsWith('did:ob:'));
  });

  it('stores createdAt timestamp', async () => {
    const before = Date.now();
    const ident  = await new Identity().init();
    const after  = Date.now();
    assert.ok(ident.createdAt >= before && ident.createdAt <= after);
  });
});

// ── Restore from localStorage ─────────────────────────────────────────────────

describe('Identity — init() restore from storage', () => {
  it('loads same identity on second init()', async () => {
    const id1   = new Identity();
    const ident1 = await id1.init();

    const id2   = new Identity();
    const ident2 = await id2.init();

    assert.equal(ident1.id, ident2.id, 'Second init must restore the same DID');
  });

  it('emits "identity:loaded" (not "identity:created") on restore', async () => {
    await new Identity().init(); // persist first

    const id2    = new Identity();
    const created = [];
    const loaded  = [];
    id2.on('identity:created', e => created.push(e));
    id2.on('identity:loaded',  e => loaded.push(e));
    await id2.init();

    assert.equal(created.length, 0, 'Should NOT emit identity:created on restore');
    assert.equal(loaded.length,  1, 'Should emit identity:loaded on restore');
  });

  it('regenerates identity when localStorage contains corrupted JSON', async () => {
    const storageKey = config.get('identity.storageKey');
    mockLS.setItem(storageKey, 'not-valid-json{{{{');

    const events = [];
    const id     = new Identity();
    id.on('identity:created', e => events.push(e));
    await id.init();

    assert.equal(events.length, 1, 'Should generate new identity when stored data is corrupted');
  });

  it('regenerates identity when stored object is missing required fields', async () => {
    const storageKey = config.get('identity.storageKey');
    mockLS.setItem(storageKey, JSON.stringify({ id: 'did:ob:abc' })); // missing keys

    const events = [];
    const id     = new Identity();
    id.on('identity:created', e => events.push(e));
    await id.init();

    assert.equal(events.length, 1, 'Incomplete stored identity should trigger regeneration');
  });
});

// ── Accessors ─────────────────────────────────────────────────────────────────

describe('Identity — get() / id / isInitialized()', () => {
  it('get() throws before init()', () => {
    assert.throws(() => new Identity().get(), /not initialized/i);
  });

  it('get() returns the identity after init()', async () => {
    const ident = new Identity();
    await ident.init();
    assert.doesNotThrow(() => ident.get());
    assert.ok(ident.get().id.startsWith('did:ob:'));
  });

  it('id getter returns the DID string', async () => {
    const ident = new Identity();
    await ident.init();
    assert.ok(ident.id.startsWith('did:ob:'));
  });

  it('isInitialized() returns false before init() and true after', async () => {
    const ident = new Identity();
    assert.equal(ident.isInitialized(), false);
    await ident.init();
    assert.equal(ident.isInitialized(), true);
  });

  it('get() returns a copy — mutations do not affect internal state', async () => {
    const ident = new Identity();
    await ident.init();
    const copy = ident.get();
    copy.id = 'tampered';
    assert.notEqual(ident.get().id, 'tampered');
  });
});

// ── Private key accessors ─────────────────────────────────────────────────────

describe('Identity — private key accessors', () => {
  it('ecdhPrivateKey is a CryptoKey after init()', async () => {
    const ident = new Identity();
    await ident.init();
    assert.ok(ident.ecdhPrivateKey instanceof CryptoKey, 'ecdhPrivateKey must be a CryptoKey');
  });

  it('ecdsaPrivateKey is a CryptoKey after init()', async () => {
    const ident = new Identity();
    await ident.init();
    assert.ok(ident.ecdsaPrivateKey instanceof CryptoKey, 'ecdsaPrivateKey must be a CryptoKey');
  });

  it('both private keys are null before init()', () => {
    const ident = new Identity();
    assert.equal(ident.ecdhPrivateKey,  null);
    assert.equal(ident.ecdsaPrivateKey, null);
  });
});

// ── export() ─────────────────────────────────────────────────────────────────

describe('Identity — export()', () => {
  it('returns valid JSON with public fields only', async () => {
    const ident = new Identity();
    await ident.init();
    const exported = JSON.parse(ident.export());
    assert.ok(exported.id);
    assert.ok(exported.publicKeyJWK);
    assert.ok(exported.signingKeyJWK);
    assert.equal(exported.privateKeyJWK,  undefined, 'Private key must NOT appear in export');
  });

  it('throws before init()', () => {
    assert.throws(() => new Identity().export(), /not initialized/i);
  });
});

// ── reset() ──────────────────────────────────────────────────────────────────

describe('Identity — reset()', () => {
  it('sets isInitialized() to false', async () => {
    const ident = new Identity();
    await ident.init();
    ident.reset();
    assert.equal(ident.isInitialized(), false);
  });

  it('clears keys from memory', async () => {
    const ident = new Identity();
    await ident.init();
    ident.reset();
    assert.equal(ident.ecdhPrivateKey,  null);
    assert.equal(ident.ecdsaPrivateKey, null);
  });

  it('removes identity from localStorage', async () => {
    const storageKey = config.get('identity.storageKey');
    const ident      = new Identity();
    await ident.init();
    assert.ok(mockLS.getItem(storageKey), 'Sanity: identity should be persisted');

    ident.reset();
    assert.equal(mockLS.getItem(storageKey), null, 'Reset should remove storage entry');
  });

  it('emits "identity:reset" event', async () => {
    const events = [];
    const ident  = new Identity();
    await ident.init();
    ident.on('identity:reset', e => events.push(e));
    ident.reset();
    assert.equal(events.length, 1);
  });

  it('allows generating a new identity after reset()', async () => {
    const ident = new Identity();
    const first = await ident.init();
    ident.reset();
    const second = await ident.init();
    // New key pair → different DID
    assert.notEqual(first.id, second.id, 'New identity after reset must have different DID');
  });
});

// ── Without localStorage ──────────────────────────────────────────────────────

describe('Identity — without localStorage', () => {
  it('generates fresh identity gracefully when localStorage is unavailable', async () => {
    const saved = globalThis.localStorage;
    delete globalThis.localStorage;

    try {
      const events = [];
      const ident  = new Identity();
      ident.on('identity:created', e => events.push(e));
      const result = await ident.init();

      assert.ok(result.id.startsWith('did:ob:'));
      assert.equal(events.length, 1);
    } finally {
      globalThis.localStorage = saved;
    }
  });

  it('reset() does not throw when localStorage is unavailable', async () => {
    const ident = new Identity();
    await ident.init();

    const saved = globalThis.localStorage;
    delete globalThis.localStorage;
    try {
      assert.doesNotThrow(() => ident.reset());
    } finally {
      globalThis.localStorage = saved;
    }
  });
});
