/**
 * GeoConsent — 地理位置隐私告知与授权管理
 *
 * 解决的问题：
 *   应用使用 H3 L9 (~0.1km²) 定位用户进行邻里分组，
 *   原来未告知用户定位精度和用途，存在合规风险和信任风险。
 *
 * 实现：
 *   1. 首次请求位置前弹出完整隐私说明
 *   2. 用户可选三种精度级别（精确/中等/城市）
 *   3. 同意记录写入 IndexedDB（含版本、时间戳）
 *   4. 提供随时撤回同意的入口
 *   5. H3 分辨率根据用户选择自动调整
 *   6. 已同意则静默返回，不重复弹窗
 *
 * 使用方式：
 *   // App 初始化时
 *   const { lat, lng, h3Cell, resolution } = await GeoConsent.getLocation();
 *
 *   // 设置页面显示当前设置
 *   GeoConsent.showSettings();
 *
 *   // 撤回同意
 *   await GeoConsent.revoke();
 */

const GeoConsent = (() => {
  const CONSENT_VERSION = '1.0';  // 隐私政策版本，升级后重新弹窗

  // H3 分辨率对照表
  // 分辨率越大，格子越小，定位越精确
  const RESOLUTIONS = {
    precise: {
      h3Res:       9,
      label:       '精确（~0.1km²）',
      desc:        '精确到你家附近 100 米，可看到最近的邻居物品',
      icon:        '📍',
      recommended: true,
    },
    medium: {
      h3Res:       7,
      label:       '中等（~5km²）',
      desc:        '精确到所在街区，约 2-3 个街道范围',
      icon:        '📌',
      recommended: false,
    },
    city: {
      h3Res:       5,
      label:       '城市级（~250km²）',
      desc:        '只知道你在 Calgary 哪个大区，隐私最强但可能看不到附近物品',
      icon:        '🏙️',
      recommended: false,
    },
  };

  // ── 同意记录存储 ──────────────────────────────────────────────────────────

  const STORAGE_KEY = 'ob_geo_consent';

  function _saveConsent(record) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch { /* 存储满了降级忽略 */ }
  }

  function _loadConsent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _hasValidConsent() {
    const c = _loadConsent();
    return c && c.version === CONSENT_VERSION && c.granted === true;
  }

  // ── 实际定位 ──────────────────────────────────────────────────────────────

  function _getH3Cell(lat, lng, resolution) {
    // H3 库由 index.html 全局加载（h3-js.js）
    if (typeof h3 !== 'undefined' && h3.latLngToCell) {
      return h3.latLngToCell(lat, lng, resolution);
    }
    // 降级：用简单字符串作为房间 ID
    const factor = Math.pow(10, resolution < 7 ? 2 : resolution < 9 ? 3 : 4);
    return `fallback_${Math.round(lat * factor)}_${Math.round(lng * factor)}`;
  }

  function _requestPosition(options = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('此浏览器不支持地理位置'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: options.enableHighAccuracy ?? true,
        timeout:            options.timeout ?? 10000,
        maximumAge:         options.maximumAge ?? 30000,
      });
    });
  }

  // ── 主入口 ────────────────────────────────────────────────────────────────

  /**
   * 获取用户位置（含同意检查）
   * 如已同意 → 静默定位并返回
   * 如未同意 → 弹出隐私告知 UI → 用户选择 → 定位 → 返回
   *
   * @returns {Promise<{lat, lng, h3Cell, resolution, accuracy}>}
   */
  async function getLocation() {
    // 已有有效同意记录，直接定位
    if (_hasValidConsent()) {
      const consent = _loadConsent();
      return _doLocate(consent.resolution);
    }

    // 需要弹窗
    const resolution = await _showConsentUI();
    return _doLocate(resolution);
  }

  async function _doLocate(resolution) {
    const resInfo = RESOLUTIONS[resolution] || RESOLUTIONS.precise;

    let lat, lng, accuracy;
    try {
      const pos = await _requestPosition({
        enableHighAccuracy: resolution === 'precise',
      });
      lat      = pos.coords.latitude;
      lng      = pos.coords.longitude;
      accuracy = pos.coords.accuracy;
    } catch (e) {
      // 定位失败，使用 Calgary 市中心作为默认值
      console.warn('[GeoConsent] Location failed, using Calgary default:', e.message);
      lat      = 51.0447;
      lng      = -114.0719;
      accuracy = 99999;
    }

    const h3Cell = _getH3Cell(lat, lng, resInfo.h3Res);

    return { lat, lng, h3Cell, resolution, h3Resolution: resInfo.h3Res, accuracy };
  }

  /**
   * 显示隐私设置（供设置页面调用）
   * @returns {Promise<string>} 用户选择的精度级别
   */
  function showSettings() {
    return new Promise((resolve) => {
      _injectStyles();

      const current = _loadConsent()?.resolution || 'precise';

      const overlay = document.createElement('div');
      overlay.id    = '_geo_overlay';

      const card = document.createElement('div');
      card.id     = '_geo_card';
      card.innerHTML = `
        <div class="_geo_header">
          <div class="_geo_icon">🗺️</div>
          <div>
            <div class="_geo_title">位置隐私设置</div>
            <div class="_geo_sub">随时可以修改你的位置精度偏好</div>
          </div>
        </div>
        <div class="_geo_options" id="_geo_opts"></div>
        <div class="_geo_footer">
          <button class="_geo_btn _geo_primary" id="_geo_save">保存设置</button>
          <button class="_geo_btn _geo_ghost"   id="_geo_cancel">取消</button>
          <button class="_geo_btn _geo_danger"  id="_geo_revoke">撤回位置授权</button>
        </div>
        <div class="_geo_hint">
          撤回授权后，你将只能看到 Calgary 全市的物品，<br>无法按距离排序或找到附近邻居。
        </div>
      `;

      let selected = current;
      const optsEl = card.querySelector('#_geo_opts');
      _buildOptions(optsEl, selected, (v) => { selected = v; });

      card.querySelector('#_geo_save').onclick = () => {
        const consent = { ..._loadConsent(), resolution: selected, updatedAt: Date.now() };
        _saveConsent(consent);
        _removeOverlay('_geo_overlay');
        resolve(selected);
      };

      card.querySelector('#_geo_cancel').onclick = () => {
        _removeOverlay('_geo_overlay');
        resolve(current);
      };

      card.querySelector('#_geo_revoke').onclick = async () => {
        if (confirm('确定撤回位置授权？将无法看到附近物品。')) {
          await revoke();
          _removeOverlay('_geo_overlay');
          resolve(null);
        }
      };

      overlay.appendChild(card);
      document.body.appendChild(overlay);
    });
  }

  /**
   * 撤回同意
   */
  async function revoke() {
    localStorage.removeItem(STORAGE_KEY);
    console.log('[GeoConsent] Location consent revoked');
  }

  /**
   * 检查是否已同意
   */
  function hasConsent() {
    return _hasValidConsent();
  }

  /**
   * 获取当前同意详情
   */
  function getConsentRecord() {
    return _loadConsent();
  }

  // ── 同意弹窗 UI ───────────────────────────────────────────────────────────

  function _showConsentUI() {
    return new Promise((resolve, reject) => {
      _injectStyles();
      _removeOverlay('_geo_overlay');

      let selectedResolution = 'precise';

      const overlay = document.createElement('div');
      overlay.id    = '_geo_overlay';

      const card = document.createElement('div');
      card.id     = '_geo_card';
      card.innerHTML = `
        <div class="_geo_header">
          <div class="_geo_icon">📍</div>
          <div>
            <div class="_geo_title">使用你的位置</div>
            <div class="_geo_sub">在使用之前，请了解我们如何使用你的位置信息</div>
          </div>
        </div>

        <div class="_geo_section">
          <div class="_geo_section_title">用途说明</div>
          <div class="_geo_use_list">
            <div class="_geo_use_item">
              <span>🏘️</span>
              <span>将你分配到 H3 地理格子，只与同一格子内的邻居共享物品信息</span>
            </div>
            <div class="_geo_use_item">
              <span>📏</span>
              <span>计算你与物品的距离，帮助你找到最近的物品</span>
            </div>
            <div class="_geo_use_item">
              <span>🔒</span>
              <span>位置<strong>永远不会上传</strong>到任何服务器，只在你的设备和 P2P 网络中使用</span>
            </div>
            <div class="_geo_use_item">
              <span>🚫</span>
              <span>我们<strong>不会</strong>追踪你的移动轨迹，<strong>不会</strong>向第三方出售位置数据</span>
            </div>
          </div>
        </div>

        <div class="_geo_section">
          <div class="_geo_section_title">选择位置精度</div>
          <div class="_geo_options" id="_geo_opts"></div>
        </div>

        <div class="_geo_footer">
          <button class="_geo_btn _geo_primary" id="_geo_agree">同意并继续</button>
          <button class="_geo_btn _geo_ghost"   id="_geo_deny">拒绝（仅浏览 Calgary 全市）</button>
        </div>

        <div class="_geo_hint">
          你可以随时在设置中修改或撤回位置授权。<br>
          本政策版本：v${CONSENT_VERSION} · 最后更新：2026-03-16
        </div>
      `;

      const optsEl = card.querySelector('#_geo_opts');
      _buildOptions(optsEl, selectedResolution, (v) => { selectedResolution = v; });

      card.querySelector('#_geo_agree').onclick = () => {
        _saveConsent({
          version:    CONSENT_VERSION,
          granted:    true,
          resolution: selectedResolution,
          grantedAt:  new Date().toISOString(),
          ua:         navigator.userAgent.slice(0, 80),
        });
        _removeOverlay('_geo_overlay');
        resolve(selectedResolution);
      };

      card.querySelector('#_geo_deny').onclick = () => {
        _saveConsent({
          version:   CONSENT_VERSION,
          granted:   false,
          resolution: 'city',
          deniedAt:  new Date().toISOString(),
        });
        _removeOverlay('_geo_overlay');
        resolve('city');  // 拒绝时降级到城市级
      };

      overlay.appendChild(card);
      document.body.appendChild(overlay);
    });
  }

  function _buildOptions(container, currentVal, onChange) {
    container.innerHTML = '';
    Object.entries(RESOLUTIONS).forEach(([key, info]) => {
      const item = document.createElement('div');
      item.className = '_geo_opt' + (key === currentVal ? ' _selected' : '');
      item.dataset.val = key;
      item.innerHTML = `
        <div class="_geo_opt_row">
          <span class="_geo_opt_icon">${info.icon}</span>
          <div class="_geo_opt_text">
            <div class="_geo_opt_label">
              ${info.label}
              ${info.recommended ? '<span class="_geo_badge">推荐</span>' : ''}
            </div>
            <div class="_geo_opt_desc">${info.desc}</div>
          </div>
          <div class="_geo_radio ${key === currentVal ? '_checked' : ''}"></div>
        </div>
      `;
      item.onclick = () => {
        container.querySelectorAll('._geo_opt').forEach(el => {
          el.classList.remove('_selected');
          el.querySelector('._geo_radio').classList.remove('_checked');
        });
        item.classList.add('_selected');
        item.querySelector('._geo_radio').classList.add('_checked');
        onChange(key);
      };
      container.appendChild(item);
    });
  }

  function _removeOverlay(id = '_geo_overlay') {
    document.getElementById(id)?.remove();
  }

  // ── CSS ──────────────────────────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('_geo_style')) return;
    const s = document.createElement('style');
    s.id = '_geo_style';
    s.textContent = `
      #_geo_overlay {
        position: fixed; inset: 0; z-index: 9990;
        background: rgba(0,0,0,.6);
        backdrop-filter: blur(10px);
        display: flex; align-items: flex-end; justify-content: center;
        animation: _geoFadeIn .2s ease;
        padding-bottom: env(safe-area-inset-bottom, 0);
      }
      @keyframes _geoFadeIn { from { opacity:0 } to { opacity:1 } }

      #_geo_card {
        background: var(--color-background-primary, #fff);
        border-radius: 24px 24px 0 0;
        padding: 24px 20px 28px;
        width: 100%; max-width: 480px;
        max-height: 88svh; overflow-y: auto;
        display: flex; flex-direction: column; gap: 20px;
        animation: _geoSlideUp .3s cubic-bezier(.4,0,.2,1);
      }
      @keyframes _geoSlideUp { from { transform: translateY(40px); opacity:0 } to { transform:none; opacity:1 } }

      ._geo_header {
        display: flex; align-items: center; gap: 14px;
      }
      ._geo_icon  { font-size: 36px; flex-shrink: 0; }
      ._geo_title { font-size: 18px; font-weight: 600; color: var(--color-text-primary,#111); }
      ._geo_sub   { font-size: 13px; color: var(--color-text-secondary,#888); margin-top: 2px; }

      ._geo_section { display: flex; flex-direction: column; gap: 10px; }
      ._geo_section_title {
        font-size: 13px; font-weight: 600;
        color: var(--color-text-secondary, #888);
        text-transform: uppercase; letter-spacing: .04em;
      }

      ._geo_use_list { display: flex; flex-direction: column; gap: 8px; }
      ._geo_use_item {
        display: flex; gap: 10px; align-items: flex-start;
        font-size: 14px; line-height: 1.5; color: var(--color-text-primary,#111);
      }
      ._geo_use_item span:first-child { flex-shrink: 0; font-size: 16px; margin-top: 1px; }

      ._geo_options { display: flex; flex-direction: column; gap: 8px; }
      ._geo_opt {
        border: 1.5px solid var(--color-border-tertiary, rgba(0,0,0,.1));
        border-radius: 12px; padding: 12px 14px;
        cursor: pointer;
        transition: border-color .15s, background .15s;
      }
      ._geo_opt._selected {
        border-color: #1D9E75;
        background: rgba(29,158,117,.06);
      }
      ._geo_opt_row { display: flex; align-items: center; gap: 12px; }
      ._geo_opt_icon { font-size: 20px; flex-shrink: 0; }
      ._geo_opt_text { flex: 1; min-width: 0; }
      ._geo_opt_label {
        font-size: 14px; font-weight: 500;
        color: var(--color-text-primary,#111);
        display: flex; align-items: center; gap: 8px;
      }
      ._geo_opt_desc { font-size: 12px; color: var(--color-text-secondary,#888); margin-top: 2px; }
      ._geo_badge {
        font-size: 10px; font-weight: 600; padding: 2px 7px;
        background: rgba(29,158,117,.15); color: #0F6E56;
        border-radius: 999px; letter-spacing: .02em;
      }
      ._geo_radio {
        width: 20px; height: 20px; border-radius: 50%;
        border: 2px solid var(--color-border-secondary,#ccc);
        flex-shrink: 0; transition: border-color .15s;
        position: relative;
      }
      ._geo_radio._checked {
        border-color: #1D9E75;
      }
      ._geo_radio._checked::after {
        content: '';
        position: absolute; inset: 3px;
        border-radius: 50%; background: #1D9E75;
      }

      ._geo_footer { display: flex; flex-direction: column; gap: 8px; }
      ._geo_btn {
        width: 100%; padding: 14px;
        border-radius: 12px; border: none;
        font-size: 15px; font-weight: 600; cursor: pointer;
        transition: background .15s;
      }
      ._geo_primary {
        background: #1D9E75; color: #fff;
      }
      ._geo_primary:hover { background: #178a64; }
      ._geo_ghost {
        background: none;
        border: 1.5px solid var(--color-border-secondary,#ccc);
        color: var(--color-text-secondary,#888);
      }
      ._geo_danger {
        background: none;
        border: none;
        color: #E24B4A;
        font-size: 13px;
        padding: 8px;
      }

      ._geo_hint {
        font-size: 11px; color: var(--color-text-tertiary,#aaa);
        text-align: center; line-height: 1.7;
      }

      @media (prefers-color-scheme: dark) {
        #_geo_card { background: #1c1c1e; }
        ._geo_opt._selected { background: rgba(29,158,117,.1); }
        ._geo_badge { background: rgba(29,158,117,.2); color: #5DCAA5; }
      }
    `;
    document.head.appendChild(s);
  }

  return {
    getLocation,
    showSettings,
    revoke,
    hasConsent,
    getConsentRecord,
    RESOLUTIONS,
  };
})();

if (typeof module !== 'undefined') module.exports = { GeoConsent };
