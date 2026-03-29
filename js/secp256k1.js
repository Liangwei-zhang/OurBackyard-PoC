/**
 * secp256k1 + Schnorr signatures (BIP-340)
 * Minimal implementation for Nostr event signing.
 * Based on @noble/secp256k1 by Paul Miller (paulmillr.com)
 * MIT License
 */
(function(global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.secp256k1 = {}));
})(this, function(exports) {
  'use strict';

  const B256 = 2n ** 256n;
  const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
  const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
  const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

  const modP = (a) => mod(a, P);
  const modN = (a) => mod(a, N);
  function mod(a, b) { const r = a % b; return r >= 0n ? r : b + r; }
  function pow(num, exp, mod) {
    if (mod <= 0n || exp < 0n) throw new Error('pow: invalid');
    if (mod === 1n) return 0n;
    let r = 1n, base = num % mod;
    while (exp > 0n) {
      if (exp & 1n) r = r * base % mod;
      exp >>= 1n; base = base * base % mod;
    }
    return r;
  }
  const invert = (n, m = P) => {
    if (n === 0n || m <= 0n) throw new Error('no inverse');
    let a = mod(n, m), b = m, x = 0n, y = 1n;
    while (a !== 0n) { const q = b / a; [b, a] = [a, b - q * a]; [x, y] = [y, x - q * y]; }
    if (b !== 1n) throw new Error('no inverse');
    return mod(x, m);
  };
  const sqrtMod = (y) => pow(y, (P + 1n) / 4n, P);

  class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    static BASE = null; // initialized below
    static ZERO = new Point(0n, 0n);
    static fromX(x) {
      const y2 = modP(x * x % P * x + 7n);
      const y = sqrtMod(y2);
      if (modP(y * y) !== y2) throw new Error('not on curve');
      return new Point(x, (y & 1n) === 0n ? y : P - y);
    }
    static fromHex(hex) {
      const b = hexToBytes(hex);
      if (b.length === 32) return Point.fromX(bytesToNum(b));
      if (b.length === 33) {
        const x = bytesToNum(b.slice(1));
        const y2 = modP(x * x % P * x + 7n);
        const y = sqrtMod(y2);
        if (modP(y * y) !== y2) throw new Error('not on curve');
        const isOdd = (y & 1n) === 1n;
        const wantOdd = (b[0] & 1) === 1;
        return new Point(x, isOdd === wantOdd ? y : P - y);
      }
      throw new Error('invalid point');
    }
    equals(other) { return this.x === other.x && this.y === other.y; }
    negate() { return new Point(this.x, modP(-this.y)); }
    double() {
      const { x: X1, y: Y1 } = this;
      const lam = modP(3n * X1 * X1 * invert(2n * Y1));
      const X3 = modP(lam * lam - 2n * X1);
      return new Point(X3, modP(lam * (X1 - X3) - Y1));
    }
    add(other) {
      const { x: X1, y: Y1 } = this, { x: X2, y: Y2 } = other;
      if (X1 === 0n && Y1 === 0n) return other;
      if (X2 === 0n && Y2 === 0n) return this;
      if (X1 === X2 && Y1 === Y2) return this.double();
      if (X1 === X2) return Point.ZERO;
      const lam = modP((Y2 - Y1) * invert(X2 - X1));
      const X3 = modP(lam * lam - X1 - X2);
      return new Point(X3, modP(lam * (X1 - X3) - Y1));
    }
    mul(n) {
      let p = Point.ZERO, d = this;
      while (n > 0n) {
        if (n & 1n) p = p.add(d);
        d = d.double(); n >>= 1n;
      }
      return p;
    }
    toHex() { return numToHex(this.x, 32); }
    toFullHex() {
      const x = numToHex(this.x, 32), y = numToHex(this.y, 32);
      return (this.y & 1n ? '03' : '02') + x;
    }
  }
  Point.BASE = new Point(Gx, Gy);

  const numToHex = (n, l = 32) => n.toString(16).padStart(l * 2, '0');
  const hexToBytes = (h) => {
    if (h.length % 2) h = '0' + h;
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i*2, i*2+2), 16);
    return b;
  };
  const bytesToHex = (b) => Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');
  const bytesToNum = (b) => BigInt('0x' + bytesToHex(b));
  const numToBytes = (n, l = 32) => hexToBytes(numToHex(n, l));

  async function taggedHash(tag, ...msgs) {
    const enc = new TextEncoder();
    const tagHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(tag)));
    const input = new Uint8Array(tagHash.length * 2 + msgs.reduce((s, m) => s + m.length, 0));
    input.set(tagHash, 0); input.set(tagHash, 32);
    let off = 64;
    for (const m of msgs) { input.set(m, off); off += m.length; }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  }

  async function schnorrSign(msgHex, privHex) {
    const m = hexToBytes(msgHex);
    const d = mod(bytesToNum(hexToBytes(privHex)), N);
    if (d === 0n || d >= N) throw new Error('bad private key');
    const P_ = Point.BASE.mul(d);
    const rand = crypto.getRandomValues(new Uint8Array(32));
    const a = numToBytes(d);
    const t = new Uint8Array(await taggedHash('BIP0340/aux', rand));
    for (let i = 0; i < 32; i++) t[i] ^= a[i]; // t = a XOR hash(rand)
    const kBytes = numToBytes(mod(bytesToNum(
      new Uint8Array(await taggedHash('BIP0340/nonce', t, numToBytes(P_.x), m))
    ), N));
    const k = mod(bytesToNum(kBytes), N);
    if (k === 0n) throw new Error('k=0');
    const R = Point.BASE.mul(k);
    const kFinal = (R.y & 1n) === 0n ? k : N - k;
    const eBytes = new Uint8Array(await taggedHash('BIP0340/challenge',
      numToBytes(R.x), numToBytes(P_.x), m));
    const e = mod(bytesToNum(eBytes), N);
    const s = mod(kFinal + e * (P_.y & 1n ? N - d : d), N);
    return numToHex(R.x, 32) + numToHex(s, 32);
  }

  async function schnorrVerify(sigHex, msgHex, pubHex) {
    try {
      const sig = hexToBytes(sigHex), msg = hexToBytes(msgHex), pub = hexToBytes(pubHex);
      if (sig.length !== 64 || msg.length !== 32 || pub.length !== 32) return false;
      const P_ = Point.fromX(bytesToNum(pub));
      const r = bytesToNum(sig.slice(0, 32)), s = bytesToNum(sig.slice(32));
      if (r >= P || s >= N) return false;
      const eBytes = new Uint8Array(await taggedHash('BIP0340/challenge',
        sig.slice(0, 32), pub, msg));
      const e = mod(bytesToNum(eBytes), N);
      const R = Point.BASE.mul(s).add(P_.negate().mul(e));
      if (R.equals(Point.ZERO) || (R.y & 1n) !== 0n || R.x !== r) return false;
      return true;
    } catch { return false; }
  }

  function generatePrivateKey() {
    let b;
    do { b = crypto.getRandomValues(new Uint8Array(32)); }
    while (bytesToNum(b) >= N || bytesToNum(b) === 0n);
    return bytesToHex(b);
  }

  function getPublicKey(privHex) {
    const d = mod(bytesToNum(hexToBytes(privHex)), N);
    return Point.BASE.mul(d).toHex();
  }

  exports.schnorrSign = schnorrSign;
  exports.schnorrVerify = schnorrVerify;
  exports.generatePrivateKey = generatePrivateKey;
  exports.getPublicKey = getPublicKey;
  exports.hexToBytes = hexToBytes;
  exports.bytesToHex = bytesToHex;
});
