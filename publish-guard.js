/**
 * PublishGuard — Phase 1
 *
 * Time-limited publish authorisation using Ed25519 asymmetric signing.
 * The issuer holds the private key and signs tokens offline.
 * OurBackyard embeds only the public key — it can verify but never forge.
 *
 * Token format:  base64url(header) . base64url(payload) . base64url(signature)
 * Signature:     Ed25519 over UTF-8( header + "." + payload )
 *
 * Usage:
 *   const result = await PublishGuard.verify();
 *   if (!result.ok) { ... show activation UI ... return; }
 *   // proceed with publish
 */

(function (global) {
  'use strict';

  /* ── Ed25519 public key (hex) — replace with your real key before deploy ── */
  const PUBLIC_KEY_HEX =
    'REPLACE_WITH_YOUR_ED25519_PUBLIC_KEY_64_BYTES_HEX';

  const STORAGE_KEY = 'ob_publish_token';

  /* ── Optional: Key Issuance Service URL for real-time revocation checks ──
   * Set this to your Phase 2 service URL to enable online revocation.
   * Leave empty ('') to use offline-only verification (Phase 1 behaviour).
   * e.g. 'https://keys.yourapp.com'
   */
  const KIS_URL = '';   // ← set after deploying Phase 2 service

  /* ── helpers ── */
  function _b64uDecode(str) {
    const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const bin = atob(padded);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }

  function _hex2buf(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2)
      out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    return out;
  }

  function _formatDate(ts) {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  function _looksLikePublishToken(header, payload) {
    return !!(
      header &&
      payload &&
      header.typ === 'PGT' &&
      header.alg === 'Ed25519' &&
      payload.scope === 'publish'
    );
  }

  function _isConfigured() {
    return !!PUBLIC_KEY_HEX && !PUBLIC_KEY_HEX.startsWith('REPLACE_');
  }

  function _isLocalDevContext() {
    try {
      const host = global.location?.hostname || '';
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
      if (host === '0.0.0.0') return true;
      if (host.endsWith('.local') || host.endsWith('.lan')) return true;
      if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      return false;
    } catch {
      return false;
    }
  }

  /* ── core verify ── */
  async function verify(token) {
    token = (token || '').trim();
    if (!token) return { ok: false, reason: 'no_token' };

    // ── 1. Split ──
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [hB64, pB64, sB64] = parts;

    // ── 2. Decode payload ──
    let header, payload;
    try { header = JSON.parse(new TextDecoder().decode(_b64uDecode(hB64))); }
    catch { return { ok: false, reason: 'malformed' }; }
    try { payload = JSON.parse(new TextDecoder().decode(_b64uDecode(pB64))); }
    catch { return { ok: false, reason: 'malformed' }; }
    if (!_looksLikePublishToken(header, payload)) {
      return { ok: false, reason: 'malformed' };
    }

    // ── 3. Check expiry (client clock) ──
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) {
      return { ok: false, reason: 'expired', exp: payload.exp, payload };
    }

    // ── 3b. Optional online revocation check (Phase 2) ──
    // Only runs if KIS_URL is configured AND we're online.
    if (KIS_URL && navigator.onLine) {
      try {
        const r = await fetch(`${KIS_URL}/api/verify?token=${encodeURIComponent(token)}`, {
          signal: AbortSignal.timeout(3000), // 3s timeout — fail open on slow network
        });
        const data = await r.json();
        if (!data.ok) return { ok: false, reason: data.reason || 'revoked_online' };
      } catch {
        // Network error or timeout — fail open (allow publish) to not block offline users
        console.warn('[PublishGuard] Online check failed, proceeding offline');
      }
    }

    // ── 4. Verify Ed25519 signature ──
    // Fallback: if running on HTTP (no WebCrypto subtle) skip sig check
    // and warn — only for dev/localhost.
    if (!crypto?.subtle) {
      if (!_isLocalDevContext()) {
        return { ok: false, reason: 'crypto_unavailable' };
      }
      console.warn('[PublishGuard] No WebCrypto — skipping sig check (HTTP?)');
      return { ok: true, payload, warned: true };
    }

    try {
      const pubKeyHex = PUBLIC_KEY_HEX;
      if (!_isConfigured()) {
        // Test mode fallback: no production public key is configured for this build,
        // so accept well-formed publish tokens everywhere and clearly mark DEV MODE.
        console.warn('[PublishGuard] TEST MODE — public key not set, skipping signature check');
        return { ok: true, payload, devMode: true };
      }

      const pubKey = await crypto.subtle.importKey(
        'raw', _hex2buf(pubKeyHex),
        { name: 'Ed25519' }, false, ['verify']
      );
      const message = new TextEncoder().encode(hB64 + '.' + pB64);
      const sig = _b64uDecode(sB64);
      const valid = await crypto.subtle.verify('Ed25519', pubKey, sig, message);
      if (!valid) return { ok: false, reason: 'invalid_signature' };
    } catch (e) {
      console.error('[PublishGuard] Sig verify error:', e.message);
      return { ok: false, reason: 'verify_error' };
    }

    return { ok: true, payload };
  }

  /* ── storage ── */
  function save(token) {
    try { localStorage.setItem(STORAGE_KEY, token.trim()); } catch {}
  }

  function load() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  /* ── UI helpers ── */
  async function getStatus() {
    const token = load();
    if (!token) return { state: 'none' };
    const r = await verify(token);
    if (r.ok) {
      const exp = r.payload?.exp;
      return {
        state: 'valid',
        merchantId: r.payload?.sub || '—',
        tier: r.payload?.tier || 'basic',
        expiry: exp ? _formatDate(exp) : 'No expiry',
        devMode: !!r.devMode,
        warned: !!r.warned,
      };
    }
    return { state: r.reason, exp: r.exp ? _formatDate(r.exp) : null };
  }

  /* ── Token generator (DEV ONLY — produces unsigned dev tokens) ── */
  function _b64uEncode(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function generateDevToken({ merchantId = 'dev-merchant', days = 30, tier = 'basic' } = {}) {
    const now   = Math.floor(Date.now() / 1000);
    const exp   = days === 0 ? undefined : now + days * 86400;
    const enc   = s => _b64uEncode(new TextEncoder().encode(s));
    const header  = enc(JSON.stringify({ alg: 'Ed25519', typ: 'PGT' }));
    const payload = enc(JSON.stringify({
      sub: merchantId, iat: now, ...(exp ? { exp } : {}),
      scope: 'publish', tier,
      jti: crypto.randomUUID?.() || Math.random().toString(36).slice(2),
    }));
    // Dummy signature (32 zero bytes) — only valid in DEV MODE (no public key configured)
    const fakeSig = _b64uEncode(new Uint8Array(64));
    return `${header}.${payload}.${fakeSig}`;
  }

  /* ── export ── */
  global.PublishGuard = { verify, save, load, clear, getStatus, generateDevToken, _formatDate };

})(typeof window !== 'undefined' ? window : global);
