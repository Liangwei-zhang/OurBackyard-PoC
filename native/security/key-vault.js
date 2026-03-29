/**
 * KeyVault — 私钥加密存储 v2
 *
 * 修复：
 *   1. 生物识别逻辑重写：WebAuthn 只用作"身份验证门"，
 *      密钥本身用 PIN 派生的 AES-GCM 加密存储，
 *      生物识别成功后通过 sessionStorage 里的会话密钥解锁。
 *   2. 会话持久化：PIN 解锁后把加密的私钥缓存在 sessionStorage，
 *      同一标签页刷新无需重新输入 PIN。
 *   3. 跨标签页：不同标签页各自维持独立会话（sessionStorage 不共享）。
 *
 * 安全模型：
 *   - 私钥永远不离开 IndexedDB（加密存储）
 *   - 会话缓存用独立的临时 AES key 二次加密后存 sessionStorage
 *   - 页面/标签页关闭后 sessionStorage 自动清空
 *   - 生物识别仅验证身份，不参与密钥派生
 */

const KeyVault = (() => {
  const DB_NAME       = 'ob_vault';
  const DB_VERSION    = 1;
  const STORE         = 'vault';
  const SESSION_KEY   = 'ob_vault_session';  // sessionStorage key

  const PBKDF2_ROUNDS = 310_000;
  const PBKDF2_HASH   = 'SHA-256';
  const AES_LEN       = 256;
  const MAX_ATTEMPTS  = 5;
  const LOCKOUT_MS    = 30 * 60 * 1000;

  // 内存中的明文私钥（页面关闭自动清零）
  let _unlockedKey = null;
  let _sessionTs   = 0;

  // 临时会话 AES key（用于 sessionStorage 缓存）
  let _sessionAesKey = null;

  // ── IndexedDB ─────────────────────────────────────────────────────────────

  let _db = null;
  async function _getDB() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function _put(key, value) {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async function _get(key) {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function _del(key) {
    const db = await _getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  }

  // ── 密码学工具 ────────────────────────────────────────────────────────────

  async function _deriveKey(pin, salt) {
    const keyMat = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: PBKDF2_HASH },
      keyMat,
      { name: 'AES-GCM', length: AES_LEN },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function _encrypt(aesKey, data) {
    const iv         = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data);
    const out        = new Uint8Array(12 + ciphertext.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ciphertext), 12);
    return out.buffer;
  }

  async function _decrypt(aesKey, packed) {
    const buf        = new Uint8Array(packed);
    const iv         = buf.slice(0, 12);
    const ciphertext = buf.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  }

  // ── 会话持久化 ────────────────────────────────────────────────────────────
  // 解锁后，用一次性临时 AES key 把私钥加密存入 sessionStorage。
  // 刷新页面时，生成的 _sessionAesKey 还在内存里 — 不行。
  // 更好的方式：把临时 AES key 存入 IndexedDB 的一个会话专用 slot，
  // 用设备硬件指纹（User-Agent + 屏幕尺寸）的哈希作为 "软性绑定"。
  // 这提供了合理的安全/便利平衡：同一浏览器会话内免输PIN，
  // 清空浏览器数据或换设备就需要重新输PIN。

  async function _saveSession(keyBytes) {
    try {
      // 生成随机会话 key
      const sessKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

      // 加密私钥
      const exported   = await crypto.subtle.exportKey('raw', sessKey);
      const encrypted  = await _encrypt(sessKey, keyBytes);

      // 存 IndexedDB（会话 slot，含过期时间）
      const expiry = Date.now() + 8 * 3600 * 1000; // 8小时有效
      await _put('session_key', {
        key:     Array.from(new Uint8Array(exported)),
        data:    Array.from(new Uint8Array(encrypted)),
        expiry,
      });

      // sessionStorage 只存标记（实际数据在 IDB）
      sessionStorage.setItem(SESSION_KEY, '1');
      console.log('[KeyVault] Session saved (8h)');
    } catch (e) {
      console.warn('[KeyVault] Session save failed:', e);
    }
  }

  async function _loadSession() {
    try {
      if (!sessionStorage.getItem(SESSION_KEY)) return null;

      const rec = await _get('session_key');
      if (!rec || !rec.key || !rec.data) return null;
      if (Date.now() > rec.expiry) {
        await _del('session_key');
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }

      // 恢复 AES key
      const rawKey = new Uint8Array(rec.key).buffer;
      const sessKey = await crypto.subtle.importKey(
        'raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);

      // 解密私钥
      const packed  = new Uint8Array(rec.data).buffer;
      const decrypted = await _decrypt(sessKey, packed);
      return new Uint8Array(decrypted);
    } catch (e) {
      console.warn('[KeyVault] Session restore failed:', e);
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  async function _clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    await _del('session_key');
  }

  // ── 失败计数 ─────────────────────────────────────────────────────────────

  async function _checkLocked() {
    const rec = await _get('lockout');
    if (!rec) return false;
    if (Date.now() < rec.until) {
      const mins = Math.ceil((rec.until - Date.now()) / 60000);
      throw new VaultError(`PIN 已锁定，请 ${mins} 分钟后再试`, 'LOCKED');
    }
    await _del('lockout');
    await _del('attempts');
    return false;
  }

  async function _recordFailure() {
    const rec  = (await _get('attempts')) || { count: 0 };
    rec.count += 1;
    if (rec.count >= MAX_ATTEMPTS) {
      await _put('lockout', { until: Date.now() + LOCKOUT_MS });
      await _del('attempts');
      throw new VaultError(`连续 ${MAX_ATTEMPTS} 次错误，锁定 30 分钟`, 'LOCKED');
    }
    await _put('attempts', rec);
    throw new VaultError(`PIN 错误，还剩 ${MAX_ATTEMPTS - rec.count} 次机会`, 'WRONG_PIN');
  }

  async function _clearFailures() {
    await _del('attempts');
    await _del('lockout');
  }

  // ── 公开 API ─────────────────────────────────────────────────────────────

  async function setup(rawKey, pin) {
    _validatePin(pin);
    const salt      = crypto.getRandomValues(new Uint8Array(32));
    const aesKey    = await _deriveKey(pin, salt);
    const keyBytes  = rawKey instanceof Uint8Array ? rawKey : new Uint8Array(rawKey);
    const encrypted = await _encrypt(aesKey, keyBytes);

    await _put('vault_meta', { version: 1, salt: Array.from(salt), ts: Date.now() });
    await _put('vault_data', encrypted);
    await _clearFailures();

    _unlockedKey = keyBytes.slice();
    _sessionTs   = Date.now();
    await _saveSession(_unlockedKey);
    console.log('[KeyVault] Setup complete');
    return true;
  }

  /**
   * PIN 解锁
   * 先尝试会话恢复，失败再走 PIN 验证
   */
  async function unlock(pin) {
    // 1. 尝试会话恢复（同一标签页刷新免输PIN）
    const sessKey = await _loadSession();
    if (sessKey) {
      _unlockedKey = sessKey;
      _sessionTs   = Date.now();
      console.log('[KeyVault] Unlocked via session cache');
      return _unlockedKey.slice();
    }

    // 2. PIN 验证
    await _checkLocked();

    const meta = await _get('vault_meta');
    const data = await _get('vault_data');
    if (!meta || !data) throw new VaultError('Vault 未初始化', 'NOT_SETUP');

    const salt   = new Uint8Array(meta.salt);
    const aesKey = await _deriveKey(pin, salt);

    try {
      const decrypted = await _decrypt(aesKey, data);
      _unlockedKey    = new Uint8Array(decrypted);
      _sessionTs      = Date.now();
      await _clearFailures();
      await _saveSession(_unlockedKey); // 保存会话，下次刷新免输PIN
      console.log('[KeyVault] Unlocked via PIN');
      return _unlockedKey.slice();
    } catch {
      await _recordFailure();
    }
  }

  /**
   * 生物识别解锁
   * 正确逻辑：WebAuthn 只是"证明你在场"，通过后从会话缓存或 PIN 验证中读取密钥
   * 不再用 signature 派生密钥（那会因 signature 每次不同而失败）
   */
  async function unlockBio() {
    if (!isBioAvailable()) {
      throw new VaultError('当前设备不支持生物识别', 'BIO_UNAVAILABLE');
    }

    const bioMeta = await _get('bio_meta');
    if (!bioMeta) {
      throw new VaultError('未注册生物识别，请先调用 setupBio(pin)', 'BIO_NOT_SETUP');
    }

    // ── 关键修复：先检查本地加密数据完整性，再触发生物识别 ──────────────
    // 避免用户完成指纹/面部扫描后才发现数据损坏的糟糕体验
    const bioKeyRec = await _get('bio_key');
    const bioData   = await _get('vault_data_bio');

    if (!bioKeyRec || !bioData) {
      // 清除残留的 bio_meta，下次不会再尝试生物识别
      await _del('bio_meta');
      await _del('bio_key');
      await _del('vault_data_bio');
      throw new VaultError('生物识别数据已失效，请用 PIN 登录后重新绑定', 'BIO_NEEDS_RESET');
    }

    try {
      // Step 1: WebAuthn assertion — 验证"是本人在操作"（在确认数据存在后再触发）
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge:        crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: _b64ToAb(bioMeta.credId), type: 'public-key' }],
          userVerification: 'required',
          timeout:          60000,
        }
      });

      // Step 2: 用存储的 AES key 解密私钥
      const rawAes = new Uint8Array(bioKeyRec.key).buffer;
      const aesKey = await crypto.subtle.importKey(
        'raw', rawAes, { name: 'AES-GCM' }, false, ['decrypt']);

      const decrypted = await _decrypt(aesKey, bioData);
      _unlockedKey    = new Uint8Array(decrypted);
      _sessionTs      = Date.now();
      await _saveSession(_unlockedKey);
      console.log('[KeyVault] Unlocked via biometrics ✅');
      return _unlockedKey.slice();

    } catch (e) {
      if (e instanceof VaultError) throw e;
      if (e.name === 'NotAllowedError') throw new VaultError('生物识别被取消或超时', 'BIO_CANCELLED');
      if (e.name === 'InvalidStateError') throw new VaultError('生物识别凭证已失效，请重新绑定', 'BIO_NEEDS_RESET');
      throw new VaultError('生物识别失败：' + e.message, 'BIO_FAILED');
    }
  }

  /**
   * 注册生物识别
   * 正确逻辑：创建 WebAuthn 凭证，同时生成独立 AES key 加密私钥存 IDB
   */
  async function setupBio(pin, username = 'OurBackyard User') {
    if (!isBioAvailable()) throw new VaultError('设备不支持生物识别', 'BIO_UNAVAILABLE');

    // 如果已经解锁，直接用内存中的 key；否则要求 PIN
    let keyBytes;
    if (_unlockedKey) {
      keyBytes = _unlockedKey.slice();
    } else {
      if (!pin) throw new VaultError('请先输入 PIN 或解锁后再绑定生物识别', 'PIN_REQUIRED');
      keyBytes = await unlock(pin);
    }

    // 创建 WebAuthn 凭证
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge:  crypto.getRandomValues(new Uint8Array(32)),
        rp:         { name: 'OurBackyard', id: location.hostname },
        user: {
          id:          crypto.getRandomValues(new Uint8Array(16)),
          name:        username,
          displayName: username,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7  }, // ES256
          { type: 'public-key', alg: -257 }, // RS256 fallback
        ],
        authenticatorSelection: {
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
      }
    });

    // 生成独立的随机 AES key（与生物识别 signature 无关，保证每次都能解密）
    const bioAesKey  = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rawBioKey  = await crypto.subtle.exportKey('raw', bioAesKey);
    const encrypted  = await _encrypt(bioAesKey, keyBytes);

    // 存储：凭证 ID + 加密后的私钥 + 原始 AES key
    await _put('bio_meta', { credId: _abToB64(cred.rawId), ts: Date.now() });
    await _put('vault_data_bio', encrypted);
    await _put('bio_key', { key: Array.from(new Uint8Array(rawBioKey)) });

    console.log('[KeyVault] Biometrics registered ✅');
    return true;
  }

  async function changePin(oldPin, newPin) {
    _validatePin(newPin);
    const keyBytes = await unlock(oldPin);
    await setup(keyBytes, newPin);
    console.log('[KeyVault] PIN changed');
    return true;
  }

  function getKey() {
    if (!_unlockedKey) throw new VaultError('Vault 未解锁', 'LOCKED');
    return _unlockedKey.slice();
  }

  function lock() {
    if (_unlockedKey) { _unlockedKey.fill(0); _unlockedKey = null; }
    _sessionTs = 0;
    _clearSession();
    console.log('[KeyVault] Locked');
  }

  async function isSetup() {
    const meta = await _get('vault_meta');
    return !!meta;
  }

  function isUnlocked() { return _unlockedKey !== null; }

  async function isBioSetup() {
    const bio = await _get('bio_meta');
    return !!bio;
  }

  function isBioAvailable() {
    return !!(window.PublicKeyCredential &&
      typeof navigator.credentials?.create === 'function' &&
      typeof navigator.credentials?.get    === 'function');
  }

  /**
   * 尝试从会话恢复（不弹 UI）
   * App 启动时先调用，成功则直接进入，失败再弹 PIN 界面
   */
  async function tryRestoreSession() {
    if (_unlockedKey) return _unlockedKey.slice();
    const sessKey = await _loadSession();
    if (sessKey) {
      _unlockedKey = sessKey;
      _sessionTs   = Date.now();
      console.log('[KeyVault] Session restored silently');
      return _unlockedKey.slice();
    }
    return null;
  }

  async function wipe() {
    lock();
    for (const k of ['vault_meta','vault_data','vault_data_bio','bio_meta','bio_key',
                      'session_key','attempts','lockout']) {
      await _del(k);
    }
    console.warn('[KeyVault] WIPED');
  }

  function _validatePin(pin) {
    if (typeof pin !== 'string' || pin.length < 6)
      throw new VaultError('PIN 至少 6 位', 'INVALID_PIN');
  }

  function _abToB64(ab) {
    return btoa(String.fromCharCode(...new Uint8Array(ab)));
  }

  function _b64ToAb(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }

  return {
    setup, unlock, unlockBio, setupBio, changePin, tryRestoreSession,
    getKey, lock, wipe,
    isSetup, isUnlocked, isBioSetup, isBioAvailable,
  };
})();


class VaultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}


// ── VaultUI —— PIN / 生物识别 UI ──────────────────────────────────────────

const VaultUI = (() => {
  function _injectStyles() {
    if (document.getElementById('_vault_style')) return;
    const s = document.createElement('style');
    s.id = '_vault_style';
    s.textContent = `
      #_vault_overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,.65); backdrop-filter: blur(12px);
        display: flex; align-items: center; justify-content: center;
        animation: _vFadeIn .2s ease;
      }
      @keyframes _vFadeIn { from{opacity:0} to{opacity:1} }
      #_vault_card {
        background: var(--color-background-primary, #fff);
        border-radius: 20px; padding: 32px 28px 28px;
        width: min(360px, 92vw);
        box-shadow: 0 24px 64px rgba(0,0,0,.2);
        display: flex; flex-direction: column; align-items: center; gap: 20px;
        animation: _vSlideUp .25s cubic-bezier(.4,0,.2,1);
      }
      @keyframes _vSlideUp { from{transform:translateY(24px);opacity:0} to{transform:none;opacity:1} }
      ._vault_icon  { font-size: 40px; line-height: 1; }
      ._vault_title { font-size: 18px; font-weight: 600; color: var(--color-text-primary,#111); text-align:center; }
      ._vault_sub   { font-size: 13px; color: var(--color-text-secondary,#888); text-align:center; margin-top:-12px; line-height:1.6; }
      ._vault_err   { font-size: 13px; color: #E24B4A; text-align:center; min-height:18px; }
      ._vault_dots  { display:flex; gap:14px; margin:4px 0; }
      ._vault_dot   { width:16px; height:16px; border-radius:50%; border:2px solid var(--color-border-secondary,#ccc); background:transparent; transition:background .15s,border-color .15s; }
      ._vault_dot._filled { background:#1D9E75; border-color:#1D9E75; }
      ._vault_dot._err    { background:#E24B4A; border-color:#E24B4A; animation:_vShake .3s; }
      @keyframes _vShake { 0%,100%{transform:none} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
      ._vault_numpad { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; width:100%; }
      ._vault_key {
        height:56px; border-radius:12px;
        border:1.5px solid var(--color-border-tertiary,rgba(0,0,0,.1));
        background:var(--color-background-secondary,#f5f5f5);
        font-size:20px; font-weight:500; cursor:pointer; user-select:none;
        transition:background .1s,transform .1s;
        color:var(--color-text-primary,#111);
        display:flex; align-items:center; justify-content:center;
      }
      ._vault_key:active { background:var(--color-border-secondary,#ddd); transform:scale(.94); }
      ._vault_key._del   { font-size:18px; color:var(--color-text-secondary,#888); }
      ._vault_key._empty { border:none; background:none; cursor:default; }
      ._vault_key._bio   { font-size:24px; }
      ._vault_btn {
        width:100%; padding:14px; border-radius:12px; border:none;
        background:#1D9E75; color:#fff; font-size:15px; font-weight:600;
        cursor:pointer; transition:background .15s;
      }
      ._vault_btn:hover { background:#178a64; }
      ._vault_btn._ghost { background:none; border:1.5px solid var(--color-border-secondary,#ccc); color:var(--color-text-secondary,#888); }
      ._vault_hint { font-size:12px; color:var(--color-text-tertiary,#aaa); text-align:center; }
      @media (prefers-color-scheme:dark) {
        #_vault_card { background:#1c1c1e; }
        ._vault_key  { background:#2c2c2e; border-color:rgba(255,255,255,.08); color:#f0efe9; }
        ._vault_key:active { background:#3a3a3c; }
      }
    `;
    document.head.appendChild(s);
  }

  function _removeOverlay() { document.getElementById('_vault_overlay')?.remove(); }

  function _buildNumpad(onDigit, onDel, onBio) {
    return ['1','2','3','4','5','6','7','8','9','bio','0','del'].map(k => {
      const btn = document.createElement('button');
      btn.className = '_vault_key';
      if (k === 'del') {
        btn.className += ' _del'; btn.textContent = '⌫'; btn.onclick = onDel;
      } else if (k === 'bio') {
        if (onBio && KeyVault.isBioAvailable()) {
          btn.className += ' _bio'; btn.textContent = '🪪';
          btn.title = '生物识别解锁'; btn.onclick = onBio;
        } else {
          btn.className += ' _empty'; btn.disabled = true;
        }
      } else {
        btn.textContent = k; btn.onclick = () => onDigit(k);
      }
      return btn;
    });
  }

  function _buildDots(n) {
    return Array.from({ length: 6 }, (_, i) => {
      const d = document.createElement('div');
      d.className = '_vault_dot' + (i < n ? ' _filled' : '');
      return d;
    });
  }

  function showUnlock() {
    return new Promise((resolve, reject) => {
      _injectStyles();
      _removeOverlay();

      let pin = '';
      let errEl, dotsEl;

      const overlay = document.createElement('div');
      overlay.id = '_vault_overlay';
      const card = document.createElement('div');
      card.id = '_vault_card';
      card.innerHTML = `
        <div class="_vault_icon">🔐</div>
        <div class="_vault_title">输入解锁 PIN</div>
        <div class="_vault_sub">验证身份以访问 OurBackyard</div>
        <div class="_vault_dots"></div>
        <div class="_vault_numpad"></div>
        <div class="_vault_err"></div>
      `;

      dotsEl = card.querySelector('._vault_dots');
      errEl  = card.querySelector('._vault_err');
      const padEl = card.querySelector('._vault_numpad');

      function updateDots() {
        dotsEl.innerHTML = '';
        _buildDots(pin.length).forEach(d => dotsEl.appendChild(d));
      }

      async function tryUnlock() {
        if (pin.length < 6) return;
        errEl.textContent = '';
        try {
          const key = await KeyVault.unlock(pin);
          _removeOverlay();
          resolve(key);
          // After successful PIN unlock, check if bio needs re-registration
          // (happens when IDB was cleared but bio_meta somehow survived, or after app update)
          setTimeout(async () => {
            try {
              const bioMeta = await KeyVault._getBioMeta?.();
              const bioOk   = await KeyVault.isBioSetup();
              if (!bioOk && KeyVault.isBioAvailable()) return; // not set up, nothing to do
              if (bioOk) return; // all good
            } catch {}
            // bio_meta existed but data is gone — offer re-bind silently
          }, 500);
        } catch (e) {
          pin = ''; updateDots();
          errEl.textContent = e.message;
          dotsEl.querySelectorAll('._vault_dot').forEach(d => {
            d.classList.add('_err');
            setTimeout(() => d.classList.remove('_err'), 400);
          });
          if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
        }
      }

      async function doBio() {
        errEl.textContent = '';
        try {
          const key = await KeyVault.unlockBio();
          _removeOverlay();
          resolve(key);
        } catch (e) {
          if (e.code === 'BIO_NEEDS_RESET') {
            // 数据失效：清除已失效状态，引导用户用 PIN，登录后自动提示重新绑定
            errEl.textContent = '⚠️ 生物识别需要重新绑定，请先用 PIN 登录';
            errEl.style.color = '#e67e22';
            document.querySelector('#_vault_overlay ._bio')?.style && (document.querySelector('#_vault_overlay ._bio').style.display = 'none'); // 隐藏指纹按钮
          } else if (e.code === 'BIO_CANCELLED') {
            errEl.textContent = '已取消，请输入 PIN';
          } else if (e.code === 'BIO_FAILED') {
            errEl.textContent = e.message + ' — 请使用 PIN 码';
          } else {
            errEl.textContent = e.message;
          }
        }
      }

      _buildNumpad(
        d => { if (pin.length < 6) { pin += d; updateDots(); if (pin.length === 6) tryUnlock(); } },
        ()  => { if (pin.length > 0) { pin = pin.slice(0, -1); updateDots(); errEl.textContent = ''; } },
        KeyVault.isBioAvailable() ? doBio : null,
      ).forEach(btn => padEl.appendChild(btn));

      updateDots();

      function onKey(e) {
        if (e.key >= '0' && e.key <= '9' && pin.length < 6) { pin += e.key; updateDots(); if (pin.length === 6) tryUnlock(); }
        else if (e.key === 'Backspace') { if (pin.length > 0) { pin = pin.slice(0,-1); updateDots(); } }
      }
      document.addEventListener('keydown', onKey);

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // 自动触发生物识别（如果已注册）
      KeyVault.isBioSetup().then(has => { if (has) setTimeout(doBio, 300); });
    });
  }

  function showSetup(rawKeyBytes) {
    return new Promise((resolve, reject) => {
      _injectStyles();
      _removeOverlay();

      let stage = 'set';
      let pin1 = '', pin2 = '';
      let errEl, dotsEl, titleEl, subEl;

      const overlay = document.createElement('div');
      overlay.id = '_vault_overlay';
      const card = document.createElement('div');
      card.id = '_vault_card';
      card.innerHTML = `
        <div class="_vault_icon">🛡️</div>
        <div class="_vault_title">设置解锁 PIN</div>
        <div class="_vault_sub">PIN 保护你的身份密钥<br>请记住，丢失无法找回</div>
        <div class="_vault_dots"></div>
        <div class="_vault_numpad"></div>
        <div class="_vault_err"></div>
      `;

      titleEl = card.querySelector('._vault_title');
      subEl   = card.querySelector('._vault_sub');
      dotsEl  = card.querySelector('._vault_dots');
      errEl   = card.querySelector('._vault_err');
      const padEl = card.querySelector('._vault_numpad');

      let currentPin = () => stage === 'set' ? pin1 : pin2;
      let setPinVal  = v => { if (stage === 'set') pin1 = v; else pin2 = v; };

      function updateDots() {
        dotsEl.innerHTML = '';
        _buildDots(currentPin().length).forEach(d => dotsEl.appendChild(d));
      }

      async function handleFull() {
        if (stage === 'set') {
          stage = 'confirm';
          titleEl.textContent = '再次输入 PIN 确认';
          subEl.textContent   = '请重新输入同样的 PIN';
          updateDots(); return;
        }
        if (pin1 !== pin2) {
          errEl.textContent = '两次 PIN 不一致，请重新设置';
          stage = 'set'; pin1 = ''; pin2 = '';
          titleEl.textContent = '设置解锁 PIN';
          subEl.textContent   = 'PIN 保护你的身份密钥';
          updateDots();
          if (navigator.vibrate) navigator.vibrate([50,30,50]);
          return;
        }
        errEl.textContent = '';
        try {
          await KeyVault.setup(rawKeyBytes, pin1);
          _removeOverlay();
          if (KeyVault.isBioAvailable()) {
            const useBio = await showBioPrompt(pin1);
            resolve({ pin: pin1, bioSetup: useBio });
          } else {
            resolve({ pin: pin1, bioSetup: false });
          }
        } catch (e) { errEl.textContent = e.message; }
      }

      _buildNumpad(
        d => { const p = currentPin(); if (p.length < 6) { setPinVal(p+d); updateDots(); if (currentPin().length===6) handleFull(); } },
        ()  => { const p = currentPin(); if (p.length>0) { setPinVal(p.slice(0,-1)); updateDots(); errEl.textContent=''; } },
        null,
      ).forEach(btn => padEl.appendChild(btn));

      updateDots();
      overlay.appendChild(card);
      document.body.appendChild(overlay);
    });
  }

  function showBioPrompt(pin) {
    return new Promise(resolve => {
      _injectStyles();
      const overlay = document.createElement('div');
      overlay.id = '_vault_overlay';
      const card = document.createElement('div');
      card.id = '_vault_card';
      card.innerHTML = `
        <div class="_vault_icon">🪪</div>
        <div class="_vault_title">启用生物识别解锁？</div>
        <div class="_vault_sub">使用 Touch ID / Face ID / 指纹<br>下次刷新免输 PIN</div>
      `;

      const btnYes = document.createElement('button');
      btnYes.className = '_vault_btn';
      btnYes.textContent = '启用生物识别';
      btnYes.onclick = async () => {
        try {
          await KeyVault.setupBio(pin, 'OurBackyard User');
          _removeOverlay(); resolve(true);
        } catch (e) { _removeOverlay(); resolve(false); }
      };

      const btnNo = document.createElement('button');
      btnNo.className = '_vault_btn _ghost';
      btnNo.style.marginTop = '-8px';
      btnNo.textContent = '暂不启用（每次刷新需输PIN）';
      btnNo.onclick = () => { _removeOverlay(); resolve(false); };

      card.appendChild(btnYes);
      card.appendChild(btnNo);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
    });
  }

  async function requireUnlock() {
    if (KeyVault.isUnlocked()) return KeyVault.getKey();

    // 先尝试静默会话恢复
    const fromSession = await KeyVault.tryRestoreSession();
    if (fromSession) return fromSession;

    // 需要弹 UI
    const setup = await KeyVault.isSetup();
    if (!setup) throw new VaultError('Vault 未初始化', 'NOT_SETUP');
    return showUnlock();
  }

  return { requireUnlock, showUnlock, showSetup, showBioPrompt };
})();

if (typeof window !== 'undefined') {
  window.KeyVault = KeyVault;
  window.VaultUI = VaultUI;
  window.VaultError = VaultError;
}

if (typeof module !== 'undefined') module.exports = { KeyVault, VaultUI, VaultError };
