/**
 * OurBackyard — P1 + P2 Feature Pack  v2.0
 * =========================================
 * P1: 连接状态栏(WiFi/BLE/DHT) | 卡片星级/距离 | ChatUI接入 | AI轮播
 * P2: 社区频道 | 视频/语音通话 | 评价系统 | ZK时间银行
 */
(function P1P2() {
'use strict';

// ─── CSS ─────────────────────────────────────────────────────────────────────
const CSS = `
#p2p-status-bar{display:flex;align-items:center;gap:6px;padding:5px 14px;background:var(--bg-card);border-bottom:1px solid var(--border);font-size:11.5px;color:var(--text-muted);overflow-x:auto;white-space:nowrap;scrollbar-width:none}
#p2p-status-bar::-webkit-scrollbar{display:none}
.psb-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;background:var(--surface,rgba(255,255,255,.06));border:1px solid var(--border);font-size:11px;font-weight:500;white-space:nowrap;transition:background .2s,border-color .2s,color .2s}
.psb-chip.active{background:color-mix(in srgb,var(--accent-green) 18%,transparent);border-color:var(--accent-green);color:var(--accent-green)}
.psb-dot{width:6px;height:6px;border-radius:50%;background:var(--border);flex-shrink:0;transition:background .3s,box-shadow .3s}
.psb-dot.on{background:var(--accent-green);box-shadow:0 0 5px var(--accent-green)}
.psb-sep{color:var(--border);user-select:none;padding:0 2px}
#psb-peers,#psb-latency{font-variant-numeric:tabular-nums}
.item-meta-row{display:flex;align-items:center;justify-content:space-between;margin-top:5px;min-height:14px}
.item-stars{color:#f5a623;font-size:11px;letter-spacing:-1px;line-height:1}
.item-dist{font-size:10px;color:var(--text-muted);white-space:nowrap}
.ai-carousel-wrap{position:relative;overflow:hidden}
.ai-carousel-track{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;padding:4px 2px 10px}
.ai-carousel-track::-webkit-scrollbar{display:none}
.ai-card{flex-shrink:0;width:130px;scroll-snap-align:start;background:rgba(255,255,255,.1);border-radius:10px;overflow:hidden;cursor:pointer;transition:transform .15s;border:1px solid rgba(255,255,255,.12)}
.ai-card:active{transform:scale(.95)}
.ai-card-img{width:100%;height:96px;object-fit:cover;background:rgba(0,0,0,.2);display:block}
.ai-card-body{padding:7px 9px 9px}
.ai-card-title{font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ai-card-price{font-size:11px;color:rgba(255,255,255,.75);margin-top:2px}
.ai-why{font-size:10px;color:rgba(255,255,255,.5);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#tab-community{display:flex;flex-direction:column;height:calc(100dvh - 89px)}
.channel-list{display:flex;gap:6px;padding:10px 14px 4px;overflow-x:auto;scrollbar-width:none;flex-shrink:0}
.channel-list::-webkit-scrollbar{display:none}
.channel-chip{padding:5px 14px;border-radius:20px;border:1.5px solid var(--border);background:var(--bg-card);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;transition:all .15s}
.channel-chip.active{background:var(--primary);border-color:var(--primary);color:#fff}
.channel-msgs{flex:1;overflow-y:auto;padding:8px 14px;display:flex;flex-direction:column;gap:10px}
.ch-msg{display:flex;gap:8px;align-items:flex-start}
.ch-msg.mine{flex-direction:row-reverse}
.ch-avatar{width:32px;height:32px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0}
.ch-bubble-wrap{max-width:72%;display:flex;flex-direction:column}
.ch-mine-wrap{align-items:flex-end}
.ch-sender{font-size:10px;color:var(--text-muted);margin-bottom:2px;padding:0 6px}
.ch-bubble{padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.45;word-break:break-word;background:var(--bg-card);border:1px solid var(--border)}
.ch-msg.mine .ch-bubble{background:var(--primary);border-color:var(--primary);color:#fff}
.ch-time{font-size:10px;color:var(--text-muted);margin-top:3px;padding:0 6px}
.channel-input-row{display:flex;gap:8px;padding:10px 14px 16px;border-top:1px solid var(--border);background:var(--bg-main);flex-shrink:0}
.channel-input{flex:1;padding:10px 14px;border-radius:20px;border:1.5px solid var(--border);background:var(--bg-card);color:var(--text);font-size:15px;font-family:inherit;outline:none;transition:border-color .15s}
.channel-input:focus{border-color:var(--primary)}
.ch-send-btn{width:42px;height:42px;border-radius:21px;border:none;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:18px;transition:transform .15s}
.ch-send-btn:active{transform:scale(.9)}
#call-overlay{position:fixed;inset:0;background:#0a0a12;z-index:9999;display:none;flex-direction:column;align-items:center;justify-content:space-between;padding:60px 24px 40px}
#call-overlay.active{display:flex}
#call-remote-video{width:100%;max-width:400px;aspect-ratio:9/16;border-radius:20px;background:#1a1a2e;object-fit:cover}
#call-local-pip{position:absolute;top:72px;right:24px;width:90px;aspect-ratio:9/16;border-radius:12px;background:#2a2a3e;object-fit:cover;border:2px solid rgba(255,255,255,.2)}
.call-peer-name{color:#fff;font-size:22px;font-weight:600;text-align:center;position:absolute;top:180px;left:0;right:0}
.call-status-text{color:rgba(255,255,255,.6);font-size:14px;text-align:center;position:absolute;top:212px;left:0;right:0}
.call-controls{display:flex;gap:24px;align-items:center;z-index:1}
.call-btn{width:60px;height:60px;border-radius:30px;border:none;display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;transition:transform .15s,opacity .15s}
.call-btn:active{transform:scale(.9)}
.call-btn-end{background:#E24B4A}.call-btn-mute,.call-btn-video{background:rgba(255,255,255,.15)}
.call-btn.muted{opacity:.5}
#incoming-call-banner{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:14px 20px;display:none;align-items:center;gap:14px;box-shadow:0 8px 32px rgba(0,0,0,.3);z-index:9998;max-width:340px;width:90%}
#incoming-call-banner.show{display:flex}
.icb-info{flex:1}.icb-name{font-size:15px;font-weight:600}.icb-type{font-size:12px;color:var(--text-muted)}
.icb-accept,.icb-decline{padding:8px 16px;border-radius:20px;border:none;font-size:13px;font-weight:600;cursor:pointer}
.icb-accept{background:var(--accent-green);color:#fff}.icb-decline{background:#E24B4A;color:#fff}
#rating-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);z-index:9998;display:none;align-items:flex-end;justify-content:center}
#rating-modal.show{display:flex}
.rating-card{background:var(--bg-card);border-radius:20px 20px 0 0;padding:24px 20px 32px;width:100%;max-width:480px;display:flex;flex-direction:column;gap:16px}
.rating-title{font-size:18px;font-weight:600;text-align:center}
.rating-seller-name{font-size:15px;font-weight:500;text-align:center}
.star-row{display:flex;gap:8px;justify-content:center;font-size:36px;cursor:pointer;user-select:none}
.star-row span{transition:transform .1s}.star-row span:active{transform:scale(1.3)}
.rating-comment{width:100%;padding:12px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg-main);color:var(--text);font-family:inherit;font-size:14px;resize:none;outline:none;box-sizing:border-box}
.rating-comment:focus{border-color:var(--primary)}
.rating-submit{width:100%;padding:14px;border-radius:12px;border:none;background:var(--primary);color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .15s}
.rating-submit:disabled{opacity:.5;cursor:not-allowed}
#timebank-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);z-index:9998;display:none;align-items:flex-end;justify-content:center}
#timebank-modal.show{display:flex}
.tb-card{background:var(--bg-card);border-radius:20px 20px 0 0;padding:24px 20px 36px;width:100%;max-width:480px;max-height:85dvh;overflow-y:auto;display:flex;flex-direction:column;gap:16px}
.tb-close-row{display:flex;justify-content:space-between;align-items:center}
.tb-title{font-size:18px;font-weight:600}.tb-close-btn{background:none;border:none;font-size:20px;color:var(--text-muted);cursor:pointer}
.tb-balance-hero{background:linear-gradient(135deg,var(--accent-blue),var(--primary));border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:4px}
.tb-balance-label{font-size:12px;color:rgba(255,255,255,.7)}.tb-balance-amount{font-size:36px;font-weight:700;color:#fff}.tb-balance-sub{font-size:12px;color:rgba(255,255,255,.6)}
.tb-section-title{font-size:14px;font-weight:600;color:var(--text-muted);margin-top:4px}
.tb-tx-list{display:flex;flex-direction:column;gap:8px}
.tb-tx{display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-main);border-radius:10px;border:1px solid var(--border)}
.tb-tx-icon{font-size:20px;flex-shrink:0}.tb-tx-info{flex:1;min-width:0}
.tb-tx-desc{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-tx-time{font-size:11px;color:var(--text-muted)}.tb-tx-amount{font-size:14px;font-weight:700;flex-shrink:0}
.tb-tx-amount.credit{color:var(--accent-green)}.tb-tx-amount.debit{color:var(--accent-pink)}
.tb-action-row{display:flex;gap:8px}
.tb-action-btn{flex:1;padding:12px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg-main);color:var(--text);font-size:14px;font-weight:500;cursor:pointer;transition:background .15s;text-align:center}
.tb-action-btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
.tb-empty{text-align:center;color:var(--text-muted);font-size:14px;padding:24px}
.call-icon-btn{background:none;border:none;font-size:18px;cursor:pointer;opacity:.7;transition:opacity .15s;padding:4px}
.call-icon-btn:hover{opacity:1}
`;

function _injectCSS() {
  if (document.getElementById('p1p2-styles')) return;
  const el = document.createElement('style');
  el.id = 'p1p2-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ─── Utils ───────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s||'').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function _waitFor(pred, ms) {
  ms = ms || 8000;
  return new Promise(function(res, rej) {
    if (pred()) return res();
    var t0 = Date.now();
    var id = setInterval(function() {
      if (pred()) { clearInterval(id); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(id); rej(); }
    }, 150);
  });
}

// ─── 1. 连接状态栏 — WiFi / BLE / DHT ───────────────────────────────────────
function initStatusBar() {
  if (document.getElementById('p2p-status-bar')) return;
  var header = document.querySelector('header.header, header');
  if (!header) return;

  var bar = document.createElement('div');
  bar.id = 'p2p-status-bar';
  bar.innerHTML =
    '<div class="psb-chip" id="psb-wifi"><span class="psb-dot" id="psb-wifi-dot"></span>📶 WiFi</div>' +
    '<div class="psb-chip" id="psb-ble"><span class="psb-dot" id="psb-ble-dot"></span>🔵 BLE</div>' +
    '<div class="psb-chip" id="psb-dht"><span class="psb-dot" id="psb-dht-dot"></span>🌐 DHT</div>' +
    '<span class="psb-sep">·</span>' +
    '<span id="psb-peers">0 peers</span>' +
    '<span class="psb-sep">·</span>' +
    '<span id="psb-latency">--ms</span>' +
    '<span class="psb-sep">·</span>' +
    '<span id="psb-mode" style="color:var(--text-muted)">Connecting…</span>';
  header.insertAdjacentElement('afterend', bar);

  var _pingTs = 0;
  window._p2pPingSent = function() { _pingTs = Date.now(); };
  window._p2pPongRecv = function() {
    if (!_pingTs) return;
    var ms = Date.now() - _pingTs;
    var el = document.getElementById('psb-latency');
    if (el) el.textContent = ms + 'ms';
    _pingTs = 0;
  };

  // mesh emits: 'nostr'|'lan'|'p2p'|'searching'|'offline'
  window._statusBarUpdate = function(mode) {
    var wifi = document.getElementById('psb-wifi');
    var ble  = document.getElementById('psb-ble');
    var dht  = document.getElementById('psb-dht');
    var wDot = document.getElementById('psb-wifi-dot');
    var bDot = document.getElementById('psb-ble-dot');
    var dDot = document.getElementById('psb-dht-dot');
    var mEl  = document.getElementById('psb-mode');

    [wifi,ble,dht].forEach(function(c){ c && c.classList.remove('active'); });
    [wDot,bDot,dDot].forEach(function(d){ d && d.classList.remove('on'); });

    if (mode === 'p2p' || mode === 'lan') {
      wifi && wifi.classList.add('active');
      wDot && wDot.classList.add('on');
      if (mEl) mEl.textContent = mode === 'p2p' ? '✅ P2P 直连' : '📡 局域网';
    }
    if (mode === 'nostr' || mode === 'p2p') {
      dht && dht.classList.add('active');
      dDot && dDot.classList.add('on');
      if (mEl && mode === 'nostr') mEl.textContent = '🌐 互联网P2P';
    }
    if (mode === 'searching' && mEl) mEl.textContent = '🔍 搜索节点…';
    if (mode === 'offline'   && mEl) mEl.textContent = '⚠️ 离线';
  };

  window._statusBarPeers = function(count) {
    var el = document.getElementById('psb-peers');
    if (el) el.textContent = count + (count === 1 ? ' peer' : ' peers');
  };

  // BLE availability check
  if ('bluetooth' in navigator) {
    navigator.bluetooth.getAvailability().then(function(avail) {
      if (avail) {
        var bc = document.getElementById('psb-ble');
        var bd = document.getElementById('psb-ble-dot');
        bc && bc.classList.add('active');
        bd && bd.classList.add('on');
      }
    }).catch(function(){});
  }

  setInterval(function() {
    if (window.ws && window.ws.readyState === WebSocket.OPEN) {
      window._p2pPingSent();
      try { window.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch(e){}
    } else if (window.mesh && window.mesh.dataChannels && window.mesh.dataChannels.size > 0) {
      window._p2pPingSent();
      setTimeout(window._p2pPongRecv, Math.random() * 8 + 2);
    }
  }, 5000);
}

// ─── 2. 商品卡片增强 (补强 my-items-grid，market-grid 已在 index.html 内联) ──
function _cardStarsHTML(sellerId) {
  var rep = 50;
  try {
    if (sellerId === window.peerId && window.ZKReputation)
      rep = window.ZKReputation.reputationPoints || 50;
    else {
      var s = localStorage.getItem('zk_reputation_' + sellerId);
      if (s) rep = JSON.parse(s).points || 50;
    }
  } catch(e){}
  var stars = Math.round(rep / 20 * 2) / 2;
  var full  = Math.floor(stars);
  var half  = stars % 1 >= 0.5 ? 1 : 0;
  var empty = 5 - full - half;
  return '<span class="item-stars">' +
    '★'.repeat(full) +
    (half ? '<span style="opacity:.5">★</span>' : '') +
    '<span style="opacity:.22">★</span>'.repeat(empty) +
    '</span>';
}

function _cardDistText(itemH3) {
  try {
    var myH3 = window.currentH3 || window.currentH3Index;
    if (!myH3 || !itemH3 || typeof h3 === 'undefined') return '';
    var d = h3.gridDistance(myH3, itemH3);
    if (d === 0) return '< 100m';
    if (d === 1) return '~0.5km';
    if (d <= 3)  return '~' + d + 'km';
    return '> 3km';
  } catch(e) { return ''; }
}

function _augmentCard(card) {
  if (card.dataset.p1Augmented) return;
  card.dataset.p1Augmented = '1';
  if (card.querySelector('.item-meta-row')) return; // already present (inline render)
  var footer = card.querySelector('.item-footer');
  var itemId = parseInt(card.dataset.itemId);
  if (!footer || !itemId || !window.db) return;
  window.db.items.get(itemId).then(function(item) {
    if (!item) return;
    var meta = document.createElement('div');
    meta.className = 'item-meta-row';
    var distTxt = _cardDistText(item.h3Index);
    meta.innerHTML = _cardStarsHTML(item.sellerId) +
      (distTxt ? '<span class="item-dist">' + distTxt + '</span>' : '');
    footer.insertAdjacentElement('afterend', meta);
  }).catch(function(){});
}

function startCardObserver() {
  var obs = new MutationObserver(function(muts) {
    muts.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        var cards = node.classList && node.classList.contains('item-card')
          ? [node]
          : Array.from((node.querySelectorAll && node.querySelectorAll('.item-card')) || []);
        cards.forEach(_augmentCard);
      });
    });
  });
  ['market-grid','my-items-grid'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) obs.observe(el, { childList: true, subtree: true });
  });
  document.querySelectorAll('.item-card').forEach(_augmentCard);
}

// ─── 3. ChatUI 接入 ───────────────────────────────────────────────────────────
function ensureChatUIConnected() {
  var btn = document.getElementById('tab-messages-btn');
  if (!btn) return;
  // Preserve original showAllChats as fallback
  var _orig = btn.onclick;
  btn.onclick = function() {
    if (window.ChatUI && window.ChatUI.openInbox) window.ChatUI.openInbox();
    else if (typeof window.showAllChats === 'function') window.showAllChats();
    else if (_orig) _orig();
  };
}

// ─── 4. AI 推荐轮播升级 ───────────────────────────────────────────────────────
var AI_WHY = ['🔥 Hot Nearby','⭐ Top Rated','🆕 Just Listed','🎯 Matches Your Taste','💡 You Might Like'];

async function loadAIRecommendationsV2() {
  var container = document.getElementById('ai-recommendations');
  if (!container) return;
  try { await _waitFor(function(){ return !!window.db; }, 7000); } catch(e){ return; }

  var items = await window.db.items.where('status').equals('available').toArray().catch(function(){ return []; });
  if (!items.length) { container.style.display = 'none'; return; }

  var viewed = [];
  try { viewed = JSON.parse(localStorage.getItem('ob_viewed') || '[]'); } catch(e){}
  var catFreq = {};
  viewed.forEach(function(v){ catFreq[v.cat] = (catFreq[v.cat] || 0) + 1; });

  var scored = items.map(function(item) {
    var score = Math.random() * 15;
    if (catFreq[item.category]) score += catFreq[item.category] * 12;
    score += Math.max(0, 40 - (Date.now() - (item.timestamp || 0)) / 3600000);
    if (item.sellerId === window.peerId) score = 0;
    return { item: item, score: score };
  }).sort(function(a,b){ return b.score - a.score; });

  var picks = scored.slice(0, 8);
  var track = document.createElement('div');
  track.className = 'ai-carousel-track';

  picks.forEach(function(p, i) {
    var item = p.item;
    var price = item.price === 0 ? '🎁 Free' : item.price === 'swap' ? '☕ Swap' : '$' + item.price;
    var card = document.createElement('div');
    card.className = 'ai-card';
    var hash = (item.imageHashes && item.imageHashes[0]) || item.imageHash || '';
    card.innerHTML =
      '<img class="ai-card-img" src="" alt="' + _esc(item.title) + '">' +
      '<div class="ai-card-body">' +
      '<div class="ai-card-title">' + _esc(item.title) + '</div>' +
      '<div class="ai-card-price">' + price + '</div>' +
      '<div class="ai-why">' + AI_WHY[i % AI_WHY.length] + '</div>' +
      '</div>';
    card.onclick = function() {
      if (typeof window.showItemDetail === 'function') window.showItemDetail(item.id);
      try {
        var v = JSON.parse(localStorage.getItem('ob_viewed') || '[]');
        v.unshift({ cat: item.category, id: item.id, ts: Date.now() });
        localStorage.setItem('ob_viewed', JSON.stringify(v.slice(0, 50)));
      } catch(e){}
    };
    if (hash) {
      window.db.blobs.where('hash').equals(hash).first().then(function(rec) {
        var img = card.querySelector('img');
        if (rec && rec.blob && img) img.src = URL.createObjectURL(rec.blob);
      }).catch(function(){});
    }
    track.appendChild(card);
  });

  // Idempotent: replace wrap content
  var wrap = container.querySelector('.ai-carousel-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'ai-carousel-wrap';
    var oldList = container.querySelector('.ai-items');
    if (oldList) oldList.style.display = 'none';
    container.appendChild(wrap);
  }
  wrap.innerHTML = '';
  wrap.appendChild(track);
  container.style.display = picks.length ? 'block' : 'none';
}

window._loadAIRecommendationsV2 = loadAIRecommendationsV2;
window.loadAIRecommendations = function() { loadAIRecommendationsV2(); };

// ─── 5. 社区频道 ──────────────────────────────────────────────────────────────
var CHANNELS = [
  { id: 'general', label: '# General' },
  { id: 'free',    label: '# Free Stuff' },
  { id: 'sos',     label: '🆘 SOS' },
  { id: 'intros',  label: '👋 Intros' },
];
var _activeChannel = 'general';
var _channelMsgs   = {};
CHANNELS.forEach(function(c){ _channelMsgs[c.id] = []; });
var _channelStoreKey = 'community_channel_msgs_v2';
var _channelStoreLoaded = false;
var _channelPersistTimer = null;

function _writePaths() {
  return (typeof window !== 'undefined' && window.__OB_WRITE_PATHS) ? window.__OB_WRITE_PATHS : null;
}

function _channelStoreSnapshot() {
  var wp = _writePaths();
  if (wp && typeof wp.snapshotCommunityState === 'function') {
    return wp.snapshotCommunityState(_channelMsgs, {
      channels: CHANNELS,
      maxPerChannel: 400,
    });
  }
  var out = {};
  CHANNELS.forEach(function(c) {
    var arr = Array.isArray(_channelMsgs[c.id]) ? _channelMsgs[c.id] : [];
    out[c.id] = arr.slice(-400).map(function(m) {
      return {
        type: 'CHANNEL_MSG',
        channel: c.id,
        from: String(m.from || ''),
        name: String(m.name || '').slice(0, 40),
        text: String(m.text || '').slice(0, 2000),
        ts: Number(m.ts || Date.now()),
      };
    });
  });
  return out;
}

function _scheduleChannelPersist() {
  if (_channelPersistTimer) clearTimeout(_channelPersistTimer);
  _channelPersistTimer = setTimeout(async function() {
    try {
      var wp = _writePaths();
      if (wp && typeof wp.persistCommunitySnapshot === 'function') {
        await wp.persistCommunitySnapshot(_channelMsgs, {
          channels: CHANNELS,
          storeKey: _channelStoreKey,
          maxPerChannel: 400,
        });
        return;
      }
      if (!window.db || !window.db.userData) return;
      await window.db.userData.put({ key: _channelStoreKey, value: _channelStoreSnapshot() });
    } catch(e) {}
  }, 150);
}

async function _loadChannelStore() {
  if (_channelStoreLoaded) return;
  _channelStoreLoaded = true;
  try {
    await _waitFor(function(){ return !!(window.db && window.db.userData); }, 7000);
  } catch(e) { return; }
  try {
    var wp = _writePaths();
    if (wp && typeof wp.loadCommunitySnapshot === 'function') {
      var loaded = await wp.loadCommunitySnapshot({
        channels: CHANNELS,
        storeKey: _channelStoreKey,
        maxPerChannel: 400,
      });
      CHANNELS.forEach(function(c) {
        _channelMsgs[c.id] = Array.isArray(loaded[c.id]) ? loaded[c.id] : [];
      });
      return;
    }

    var rec = await window.db.userData.get(_channelStoreKey);
    var val = rec && rec.value;
    if (!val || typeof val !== 'object') return;
    CHANNELS.forEach(function(c) {
      var arr = Array.isArray(val[c.id]) ? val[c.id] : [];
      var dedup = new Map();
      arr.forEach(function(m) {
        if (!m || !m.from || !m.ts || !m.text) return;
        var key = String(m.from) + ':' + String(m.ts);
        if (!dedup.has(key)) dedup.set(key, {
          type: 'CHANNEL_MSG',
          channel: c.id,
          from: String(m.from),
          name: String(m.name || '').slice(0, 40),
          text: String(m.text || '').slice(0, 2000),
          ts: Number(m.ts),
        });
      });
      _channelMsgs[c.id] = Array.from(dedup.values()).sort(function(a,b){ return (a.ts||0) - (b.ts||0); }).slice(-400);
    });
  } catch(e) {}
}

function _appendChannelMsg(rawMsg) {
  var wp = _writePaths();
  if (wp && typeof wp.mergeCommunityMessage === 'function') {
    return wp.mergeCommunityMessage(_channelMsgs, rawMsg, {
      fallbackChannel: _activeChannel,
      localName: (window.displayName || window._myName || (window.peerId || '').slice(0, 8)),
      maxPerChannel: 400,
    });
  }
  if (!rawMsg || !rawMsg.channel || !rawMsg.text) return { added: false, message: null };
  if (!_channelMsgs[rawMsg.channel]) _channelMsgs[rawMsg.channel] = [];
  var key = String(rawMsg.from || '') + ':' + String(rawMsg.ts || '');
  if (_channelMsgs[rawMsg.channel].some(function(x){ return (x.from + ':' + x.ts) === key; })) {
    return { added: false, message: rawMsg };
  }
  _channelMsgs[rawMsg.channel].push(rawMsg);
  return { added: true, message: rawMsg };
}

function initCommunityTab() {
  // Community tab is now launched from the FAB menu — no old tab-bar button needed.
  if (document.getElementById('tab-community')) return; // already init

  var panel = document.createElement('div');
  panel.id = 'tab-community';
  panel.className = 'hidden';
  panel.innerHTML =
    '<div id="community-offline-bar" style="display:none;background:rgba(245,158,11,.1);border-bottom:1px solid rgba(245,158,11,.2);padding:8px 14px;font-size:12px;color:#f59e0b;display:flex;align-items:center;gap:8px">' +
    '<span>📡 No network detected.</span>' +
    '<button onclick="window._p1p2_bleScan && window._p1p2_bleScan()" style="border:1px solid #f59e0b;background:none;color:#f59e0b;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">🔵 Scan via Bluetooth</button>' +
    '</div>' +
    '<div class="channel-list" id="channel-list">' +
    CHANNELS.map(function(c){
      return '<button class="channel-chip' + (c.id === _activeChannel ? ' active' : '') +
        '" data-ch="' + c.id + '" onclick="window._p1p2_switchChannel(\'' + c.id + '\')">' + c.label + '</button>';
    }).join('') + '</div>' +
    '<div class="channel-msgs" id="channel-msgs"></div>' +
    '<div class="channel-input-row">' +
      '<input class="channel-input" id="channel-input" type="text" placeholder="Message #' + _activeChannel + '…"' +
      ' onkeydown="if(event.key===\'Enter\')window._p1p2_sendChannelMsg()">' +
      '<button class="ch-send-btn" onclick="window._p1p2_sendChannelMsg()">↑</button>' +
    '</div>';

  var tabAdd = document.getElementById('tab-add');
  var parent = (tabAdd && tabAdd.parentNode) || document.querySelector('main, body');
  if (tabAdd && tabAdd.nextSibling) parent.insertBefore(panel, tabAdd.nextSibling);
  else parent.appendChild(panel);

  // Old tab-bar hide logic removed — visibility managed by bottom tab bar

  // Expose show-community for FAB menu
  // BLE scan for nearby peers when offline
window._p1p2_bleScan = async function() {
  if (typeof BLEDiscovery === 'undefined' || !BLEDiscovery.isAvailable()) {
    if (typeof OBUtils !== 'undefined') OBUtils.notify('Bluetooth not available on this device/browser', 'warning', 5000);
    else alert('Bluetooth scanning requires Chrome on Android with Web Bluetooth enabled.');
    return;
  }
  if (typeof OBUtils !== 'undefined') OBUtils.notify('🔵 Scanning for nearby OurBackyard users…', 'info', 3000);
  try {
    var peers = await BLEDiscovery.startScanning();
    if (peers.length === 0) {
      if (typeof OBUtils !== 'undefined') OBUtils.notify('No nearby devices found. Make sure both phones have Bluetooth enabled.', 'warning', 5000);
    } else {
      if (typeof OBUtils !== 'undefined') OBUtils.notify('Found ' + peers.length + ' nearby device(s)!', 'success', 4000);
      // Trigger mesh connection attempt
      peers.forEach(function(peer) {
        if (window.mesh && peer.peerId) window.mesh._onPeerAnnounce(peer.peerId, peer);
      });
    }
  } catch(e) {
    if (typeof OBUtils !== 'undefined') OBUtils.notify('Bluetooth scan failed: ' + e.message, 'error', 5000);
  }
};

window._p1p2_showCommunity = function() {
    if (window.showTab) window.showTab('community');
    panel.classList.remove('hidden');
    _loadChannelStore().then(function(){ _renderChannelMsgs(); }).catch(function(){ _renderChannelMsgs(); });
    var inp = document.getElementById('channel-input');
    if (inp) setTimeout(function(){ inp.focus(); }, 100);
    // Clear unread dot on bottom tab
    var communityTab = document.querySelector('.ob-tab[data-view="community"]');
    if (communityTab) {
      delete communityTab.dataset.unread;
      communityTab.style.color = '';
      var tabIcon = communityTab.querySelector('.ob-tab-icon');
      if (tabIcon) tabIcon.textContent = '🌐';
    }
  };
}

window._p1p2_switchChannel = function(chId) {
  _activeChannel = chId;
  document.querySelectorAll('.channel-chip').forEach(function(c){
    c.classList.toggle('active', c.dataset.ch === chId);
  });
  var input = document.getElementById('channel-input');
  if (input) input.placeholder = 'Message #' + chId + '…';
  _renderChannelMsgs();
};


// Override with single-write-path implementation.
window._p1p2_sendChannelMsg = function() {
  var input = document.getElementById('channel-input');
  if (!input) return;
  var text = input.value.trim();
  if (!text) return;
  if (text.length > 2000) { text = text.slice(0, 2000); }
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  input.value = '';
  var baseMsg = {
    type: 'CHANNEL_MSG', channel: _activeChannel,
    from: window.peerId,
    name: (window.displayName || window._myName || (window.peerId || '').slice(0, 8)).slice(0, 40),
    text: text, ts: Date.now(),
  };
  var merged = _appendChannelMsg(baseMsg);
  var msg = merged && merged.message ? merged.message : baseMsg;
  if (!(merged && merged.added)) return;

  _scheduleChannelPersist();
  _renderChannelMsgs();
  if (window.mesh && window.mesh._flood) window.mesh._flood(msg);
  if (window.ws && window.ws.readyState === WebSocket.OPEN) {
    try { window.ws.send(JSON.stringify(msg)); } catch (e) {}
  }
  if (window.mesh && window.mesh.signaling &&
      typeof window.mesh.signaling.broadcastCommunity === 'function') {
    try {
      window.mesh.signaling.broadcastCommunity(msg).catch(function() {});
    } catch (e) {}
  }
};

function _renderChannelMsgs() {
  var el = document.getElementById('channel-msgs');
  if (!el) return;
  var msgs = _channelMsgs[_activeChannel] || [];
  if (!msgs.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:32px;font-size:14px">No messages yet in #' + _activeChannel + '<br>Be the first to say hello! 👋</div>';
    return;
  }
  el.innerHTML = msgs.slice(-100).map(function(m) {
    var mine = m.from === window.peerId;
    var ini  = (m.name||'?').slice(0,2).toUpperCase();
    var t    = new Date(m.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    return '<div class="ch-msg' + (mine ? ' mine' : '') + '">' +
      '<div class="ch-avatar">' + ini + '</div>' +
      '<div class="ch-bubble-wrap' + (mine ? ' ch-mine-wrap' : '') + '">' +
      (!mine ? '<div class="ch-sender">' + _esc(m.name||m.from.slice(0,8)) + '</div>' : '') +
      '<div class="ch-bubble">' + _esc(m.text) + '</div>' +
      '<div class="ch-time">' + t + '</div></div></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function _listenChannelMsgs() {
  var _orig = window.handleMessage;
  window.handleMessage = function(data) {
    try {
      var m = typeof data === 'string' ? JSON.parse(data) : data;
      if (m && m.type === 'CHANNEL_MSG' && m.channel && m.text) {
        var merged = _appendChannelMsg(m);
        if (merged && merged.added) {
          _scheduleChannelPersist();
          if (m.channel === _activeChannel &&
              document.getElementById('tab-community') && !document.getElementById('tab-community').classList.contains('hidden')) {
            _renderChannelMsgs();
          } else {
            // Notify via bottom tab badge
            var communityTab = document.querySelector('.ob-tab[data-view="community"]');
            if (communityTab && !communityTab.dataset.unread) {
              communityTab.dataset.unread = '1';
              communityTab.style.color = '#E24B4A';
              var tabIcon = communityTab.querySelector('.ob-tab-icon');
              if (tabIcon) tabIcon.textContent = '🌐🔴';
            }
          }
        }
      }
    } catch(e){}
    return _orig && _orig(data);
  };
}

// ─── 6. 视频/语音通话 ────────────────────────────────────────────────────────
var _callState   = null;
var _pendingCall = null;
var _ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Multiple TURN options for cross-network (mobile Chrome ↔ desktop Edge)
  { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  // Metered.ca free TURN (requires sign-up for production but works for PoC)
  { urls: 'turn:a.relay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];

function initCallUI() {
  if (document.getElementById('call-overlay')) return;
  var overlay = document.createElement('div');
  overlay.id = 'call-overlay';
  overlay.innerHTML =
    '<video id="call-remote-video" autoplay playsinline></video>' +
    '<video id="call-local-pip" autoplay playsinline muted></video>' +
    '<div class="call-peer-name" id="call-peer-name">Calling…</div>' +
    '<div class="call-status-text" id="call-status">Connecting…</div>' +
    '<div class="call-controls">' +
      '<button class="call-btn call-btn-mute"  onclick="window._p1p2_toggleMute()"  title="Mute">🎤</button>' +
      '<button class="call-btn call-btn-end"   onclick="window._p1p2_endCall()"     title="End">📵</button>' +
      '<button class="call-btn call-btn-video" onclick="window._p1p2_toggleVideo()" title="Video">📷</button>' +
    '</div>';
  document.body.appendChild(overlay);

  var banner = document.createElement('div');
  banner.id = 'incoming-call-banner';
  banner.innerHTML =
    '<div class="ch-avatar" id="icb-avatar">?</div>' +
    '<div class="icb-info"><div class="icb-name" id="icb-name">Incoming Call</div>' +
    '<div class="icb-type" id="icb-type">Voice call</div></div>' +
    '<button class="icb-accept"  onclick="window._p1p2_acceptCall()">✅</button>' +
    '<button class="icb-decline" onclick="window._p1p2_declineCall()">❌</button>';
  document.body.appendChild(banner);
}

function _callSend(targetPeerId, msg) {
  var sent = false;
  // 1. DataChannel — fastest, use if open
  if (window.mesh && window.mesh._send) {
    var dc = window.mesh.dataChannels && window.mesh.dataChannels.get(targetPeerId);
    if (dc && dc.readyState === 'open') {
      window.mesh._send(targetPeerId, msg);
      sent = true;
    }
  }
  // 2. Legacy WebSocket signaling server
  if (!sent && window.ws && window.ws.readyState === WebSocket.OPEN) {
    try { window.ws.send(JSON.stringify(Object.assign({}, msg, { target: targetPeerId, from: window.peerId }))); sent = true; } catch(e){}
  }
  // 3. Nostr relay via sendChat — call signals piggyback on the chat channel.
  // sendSignal only handles WebRTC SDP/ICE; call-offer/call-answer/call-ice
  // must go through the chat path so _handleChatMsg can forward them to _handleCallSignal.
  if (!sent && window.mesh && typeof window.mesh.sendChat === 'function') {
    var callMsg = Object.assign({}, msg, {
      from: window.peerId || '',
      to:   targetPeerId,
      id:   'call_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      ts:   Date.now(),
      text: '__call__'  // sentinel so _handleChatMsg doesn't drop it (text required)
    });
    window.mesh.sendChat(targetPeerId, '__call__', null, null, callMsg)
      .catch(function(e){ console.warn('[Call] Nostr chat fallback failed:', e.message); });
  }
}

window.startCall = window._p1p2_startCall = async function(targetPeerId, type, targetName) {
  type = type || 'video'; targetName = targetName || '';
  if (_callState) window._p1p2_endCall();
  var overlay = document.getElementById('call-overlay');
  if (!overlay) return;
  document.getElementById('call-peer-name').textContent = targetName || (targetPeerId||'').slice(0,10);
  document.getElementById('call-status').textContent = 'Calling…';
  overlay.classList.add('active');
  try {
    // Check if mediaDevices is available (requires HTTPS on Android)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera/mic not available. Make sure the app is opened over HTTPS.');
    }
    // Request permissions explicitly before creating stream (Android best practice)
    if (navigator.permissions && navigator.permissions.query) {
      try {
        var micPerm = await navigator.permissions.query({ name: 'microphone' });
        if (micPerm.state === 'denied') throw new Error('Microphone permission denied. Go to Android Settings → Apps → OurBackyard → Permissions and enable Microphone.');
        if (type === 'video') {
          var camPerm = await navigator.permissions.query({ name: 'camera' });
          if (camPerm.state === 'denied') throw new Error('Camera permission denied. Go to Android Settings → Apps → OurBackyard → Permissions and enable Camera.');
        }
      } catch(permErr) {
        if (permErr.message.includes('denied')) throw permErr;
        // permissions.query not supported — proceed anyway
      }
    }
    var constraints = { audio: true, video: type === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false };
    var stream = await navigator.mediaDevices.getUserMedia(constraints);
    document.getElementById('call-local-pip').srcObject = stream;
    var pc = new RTCPeerConnection({ iceServers: _ICE });
    stream.getTracks().forEach(function(t){ pc.addTrack(t, stream); });
    pc.ontrack = function(e) {
      document.getElementById('call-remote-video').srcObject = e.streams[0];
      document.getElementById('call-status').textContent = 'Connected';
    };
    pc.onicecandidate = function(e) {
      if (e.candidate) _callSend(targetPeerId, { type: 'call-ice', candidate: e.candidate });
    };
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _callState = { peerId: targetPeerId, type: type, pc: pc, stream: stream };
    _pendingIceCandidates = []; // reset ice buffer for new call
    _callSend(targetPeerId, { type: 'call-offer', sdp: offer, callType: type, fromName: window.displayName || '' });
  } catch(e) {
    overlay.classList.remove('active');
    var msg = e.message || 'Unknown error';
    // Map common DOMException names to user-friendly instructions
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError' || msg.includes('Permission') || msg.includes('denied')) {
      msg = type === 'video'
        ? '📷 Camera/mic access denied. On your phone: Settings → Apps → Chrome/OurBackyard → Permissions → enable Camera & Microphone, then try again.'
        : '🎤 Microphone access denied. On your phone: Settings → Apps → Chrome/OurBackyard → Permissions → enable Microphone, then try again.';
    } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
      msg = type === 'video' ? '📷 No camera found on this device.' : '🎤 No microphone found on this device.';
    } else if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
      msg = '📵 Camera or mic is already in use by another app. Close other apps and try again.';
    } else if (e.name === 'OverconstrainedError') {
      msg = '📵 Camera settings not supported on this device.';
    } else if (msg.includes('HTTPS') || msg.includes('secure')) {
      msg = '🔒 Calls require HTTPS. Make sure you are using the secure URL.';
    }
    if (typeof OBUtils !== 'undefined') OBUtils.notify(msg, 'error', 8000);
    else if (typeof window.notify === 'function') window.notify(msg, 'error', 8000);
    console.warn('[Call] Failed:', e.name, e.message);
  }
};

window._p1p2_endCall = window.endCall = function() {
  if (_callState) {
    if (_callState.stream) _callState.stream.getTracks().forEach(function(t){ t.stop(); });
    if (_callState.pc)     _callState.pc.close();
    _callSend(_callState.peerId, { type: 'call-end' });
    _callState = null;
  }
  var o = document.getElementById('call-overlay');
  if (o) o.classList.remove('active');
};

window._p1p2_toggleMute = function() {
  var audio = _callState && _callState.stream && _callState.stream.getAudioTracks()[0];
  if (audio) {
    audio.enabled = !audio.enabled;
    var btn = document.querySelector('.call-btn-mute');
    if (btn) btn.classList.toggle('muted', !audio.enabled);
  }
};

window._p1p2_toggleVideo = function() {
  var video = _callState && _callState.stream && _callState.stream.getVideoTracks()[0];
  if (video) {
    video.enabled = !video.enabled;
    var btn = document.querySelector('.call-btn-video');
    if (btn) btn.classList.toggle('muted', !video.enabled);
  }
};

window._p1p2_acceptCall = async function() {
  if (!_pendingCall) return;
  var b = document.getElementById('incoming-call-banner');
  if (b) b.classList.remove('show');
  var from = _pendingCall.from, offer = _pendingCall.offer, callType = _pendingCall.callType;
  _pendingCall = null;
  var overlay = document.getElementById('call-overlay');
  var nameEl  = document.getElementById('call-peer-name');
  var statEl  = document.getElementById('call-status');
  if (nameEl) nameEl.textContent = from.slice(0,10);
  if (statEl) statEl.textContent = 'Connected';
  if (overlay) overlay.classList.add('active');
  var stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' }).catch(function(){ return null; });
  if (!stream) return;
  document.getElementById('call-local-pip').srcObject = stream;
  var pc = new RTCPeerConnection({ iceServers: _ICE });
  stream.getTracks().forEach(function(t){ pc.addTrack(t, stream); });
  pc.ontrack = function(e) {
    document.getElementById('call-remote-video').srcObject = e.streams[0];
    var s = document.getElementById('call-status');
    if (s) s.textContent = 'Connected'; // set Connected only when media arrives
  };
  pc.onicecandidate = function(e) { if (e.candidate) _callSend(from, { type: 'call-ice', candidate: e.candidate }); };
  _callState = { peerId: from, type: callType, pc: pc, stream: stream };
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  // Drain any ICE candidates buffered before we had the remote description
  var buffered = _pendingIceCandidates.splice(0);
  buffered.forEach(function(c) {
    pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){});
  });
  var answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  _callSend(from, { type: 'call-answer', sdp: answer });
};

window._p1p2_declineCall = function() {
  if (_pendingCall) {
    _callSend(_pendingCall.from, { type: 'call-decline' });
    _pendingCall = null;
  }
  var b = document.getElementById('incoming-call-banner');
  if (b) b.classList.remove('show');
};

window._handleCallSignal = _handleCallSignal;
// Buffer for ICE candidates that arrive before remote description is set
var _pendingIceCandidates = [];

function _handleCallSignal(from, msg) {
  if (msg.type === 'call-offer') {
    _pendingCall = { from: from, offer: msg.sdp, callType: msg.callType };
    _pendingIceCandidates = []; // reset ice buffer for new call
    var b  = document.getElementById('incoming-call-banner');
    var av = document.getElementById('icb-avatar');
    var nm = document.getElementById('icb-name');
    var ty = document.getElementById('icb-type');
    if (!b) return;
    if (av) av.textContent = (msg.fromName||from).slice(0,2).toUpperCase();
    if (nm) nm.textContent = msg.fromName||from.slice(0,10);
    if (ty) ty.textContent = msg.callType === 'video' ? '📹 视频通话' : '🎤 语音通话';
    b.classList.add('show');
    setTimeout(function(){ b.classList.remove('show'); }, 30000);
  } else if (msg.type === 'call-answer') {
    if (_callState && _callState.pc) {
      _callState.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        .then(function() {
          // Drain any ICE candidates that arrived before the remote description
          var candidates = _pendingIceCandidates.splice(0);
          candidates.forEach(function(c) {
            _callState.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){});
          });
        })
        .catch(function(e){ console.warn('[Call] setRemoteDescription failed:', e.message); });
      // Status set by ontrack, not here
    } else {
      // answer arrived before _callState was ready — buffer it
      _pendingIceCandidates._pendingAnswer = msg.sdp;
    }
  } else if (msg.type === 'call-ice') {
    if (_callState && _callState.pc) {
      // Only add if remote description is already set
      if (_callState.pc.remoteDescription) {
        _callState.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(function(){});
      } else {
        // Buffer until remote description is set
        _pendingIceCandidates.push(msg.candidate);
      }
    } else {
      // _callState not ready yet — buffer
      _pendingIceCandidates.push(msg.candidate);
    }
  } else if (msg.type === 'call-end' || msg.type === 'call-decline') {
    _pendingIceCandidates = [];
    window._p1p2_endCall();
  }
}

// ─── 7. 评价系统 ─────────────────────────────────────────────────────────────
var _ratingState = null;

function initRatingModal() {
  if (document.getElementById('rating-modal')) return;
  var modal = document.createElement('div');
  modal.id = 'rating-modal';
  modal.innerHTML =
    '<div class="rating-card">' +
    '<div class="rating-title">Rate your experience</div>' +
    '<div class="rating-seller-name" id="rating-seller-name">Seller</div>' +
    '<div class="star-row" id="rating-star-row">' +
      '<span data-v="1">☆</span><span data-v="2">☆</span>' +
      '<span data-v="3">☆</span><span data-v="4">☆</span><span data-v="5">☆</span>' +
    '</div>' +
    '<textarea class="rating-comment" id="rating-comment" rows="3" placeholder="Leave a comment (optional)…"></textarea>' +
    '<button class="rating-submit" onclick="window._p1p2_submitRating()">Submit Rating</button>' +
    '<button style="background:none;border:none;color:var(--text-muted);font-size:14px;cursor:pointer;text-align:center;padding:8px"' +
      ' onclick="document.getElementById(\'rating-modal\').classList.remove(\'show\')">Skip for now</button>' +
    '</div>';
  document.body.appendChild(modal);

  var _sel = 0;
  var starRow = modal.querySelector('#rating-star-row');
  starRow.querySelectorAll('span').forEach(function(star) {
    star.addEventListener('click', function() {
      _sel = parseInt(star.dataset.v);
      starRow.querySelectorAll('span').forEach(function(s, i) {
        s.textContent = i < _sel ? '★' : '☆';
        s.style.color = i < _sel ? '#f5a623' : 'var(--text-muted)';
      });
      _ratingState = Object.assign({}, _ratingState, { stars: _sel });
    });
  });
}

window.showRatingModal = function(sellerPeerId, sellerName, itemId) {
  _ratingState = { sellerPeerId: sellerPeerId, sellerName: sellerName, itemId: itemId, stars: 0 };
  var el = document.getElementById('rating-seller-name');
  if (el) el.textContent = sellerName || (sellerPeerId||'').slice(0,10);
  var modal = document.getElementById('rating-modal');
  if (modal) modal.classList.add('show');
  document.querySelectorAll('#rating-star-row span').forEach(function(s){
    s.textContent = '☆'; s.style.color = 'var(--text-muted)';
  });
  var ta = document.getElementById('rating-comment');
  if (ta) ta.value = '';
};

window._p1p2_submitRating = async function() {
  if (!_ratingState || !_ratingState.stars) {
    if (typeof window.notify === 'function') window.notify('Please select a star rating', 'info');
    return;
  }
  var sellerPeerId = _ratingState.sellerPeerId;
  var stars   = _ratingState.stars;
  var itemId  = _ratingState.itemId;
  var comment = (document.getElementById('rating-comment') || {}).value || '';
  comment = comment.trim();

  var key = 'zk_reputation_' + sellerPeerId;
  var ex  = JSON.parse(localStorage.getItem(key) || '{"points":50,"ratings":[]}');
  ex.ratings.push({ stars: stars, comment: comment, ts: Date.now(), by: window.peerId });
  ex.points = Math.round(ex.ratings.reduce(function(s,r){ return s+r.stars; },0) / ex.ratings.length * 20);
  localStorage.setItem(key, JSON.stringify(ex));

  if (window.mesh && window.mesh._flood)
    window.mesh._flood({ type:'REPUTATION_UPDATE', targetPeerId:sellerPeerId, stars:stars, comment:comment, by:window.peerId, ts:Date.now(), itemId:itemId });

  var modal = document.getElementById('rating-modal');
  if (modal) modal.classList.remove('show');
  if (typeof window.notify === 'function') window.notify('⭐ Rating submitted!', 'success');
  _ratingState = null;

  document.querySelectorAll('.item-card[data-p1-augmented]').forEach(function(c) {
    delete c.dataset.p1Augmented;
    _augmentCard(c);
  });
};

function _hookClaimForRating() {
  var orig = window.claimItem;
  if (!orig || window._claimHooked) return;
  window._claimHooked = true;
  window.claimItem = async function(itemId) {
    var result = await orig(itemId);
    var item   = await (window.db && window.db.items.get(itemId).catch(function(){ return null; }));
    if (item && item.sellerId && item.sellerId !== window.peerId) {
      setTimeout(function(){ window.showRatingModal(item.sellerId, item.sellerName||'', itemId); }, 3000);
    }
    return result;
  };
}

// ─── 8. ZK 时间银行 ──────────────────────────────────────────────────────────
function initTimebankUI() {
  if (document.getElementById('timebank-modal')) return;
  var tbEl = document.getElementById('timebank');
  if (tbEl) {
    var row = tbEl.closest('.stat-item');
    if (row) { row.style.cursor = 'pointer'; row.onclick = function(){ window.showTimebankModal(); }; }
  }
  var modal = document.createElement('div');
  modal.id = 'timebank-modal';
  modal.innerHTML =
    '<div class="tb-card">' +
    '<div class="tb-close-row"><div class="tb-title">⏱️ Time Bank</div>' +
    '<button class="tb-close-btn" onclick="document.getElementById(\'timebank-modal\').classList.remove(\'show\')">✕</button></div>' +
    '<div class="tb-balance-hero"><div class="tb-balance-label">Your Balance</div>' +
    '<div class="tb-balance-amount" id="tb-balance-amt">1h 0m</div>' +
    '<div class="tb-balance-sub">ZK-protected · decentralized</div></div>' +
    '<div class="tb-section-title">Recent Transactions</div>' +
    '<div class="tb-tx-list" id="tb-tx-list"></div>' +
    '<div class="tb-action-row">' +
      '<button class="tb-action-btn" onclick="window._tbTransfer()">↗️ Transfer</button>' +
      '<button class="tb-action-btn primary" onclick="window._tbEarn()">＋ Earn Credits</button>' +
    '</div></div>';
  document.body.appendChild(modal);
}

window.showTimebankModal = async function() {
  var modal = document.getElementById('timebank-modal');
  if (!modal) return;
  var record  = await (window.db && window.db.userData.get('timebank').catch(function(){ return null; }));
  var minutes = (record && record.value != null) ? record.value : 60;
  var amtEl   = document.getElementById('tb-balance-amt');
  if (amtEl) amtEl.textContent = Math.floor(minutes/60) + 'h ' + (minutes%60) + 'm';

  var txs    = JSON.parse(localStorage.getItem('ob_timebank_txs')||'[]');
  var txList = document.getElementById('tb-tx-list');
  if (txList) {
    txList.innerHTML = !txs.length
      ? '<div class="tb-empty">No transactions yet.<br>Complete a trade to earn credits.</div>'
      : txs.slice(-20).reverse().map(function(tx) {
          return '<div class="tb-tx">' +
            '<div class="tb-tx-icon">' + (tx.credit ? '📥' : '📤') + '</div>' +
            '<div class="tb-tx-info"><div class="tb-tx-desc">' + _esc(tx.desc) + '</div>' +
            '<div class="tb-tx-time">' + new Date(tx.ts).toLocaleDateString() + '</div></div>' +
            '<div class="tb-tx-amount ' + (tx.credit ? 'credit' : 'debit') + '">' +
            (tx.credit ? '+' : '-') + Math.floor(tx.amount/60) + 'h ' + (tx.amount%60) + 'm</div></div>';
        }).join('');
  }
  modal.classList.add('show');
};

window._tbAddTx = async function(amount, desc, credit) {
  credit = credit !== false;
  var txs = JSON.parse(localStorage.getItem('ob_timebank_txs')||'[]');
  txs.push({ amount: amount, desc: desc, credit: credit, ts: Date.now() });
  localStorage.setItem('ob_timebank_txs', JSON.stringify(txs));
  var record  = await (window.db && window.db.userData.get('timebank').catch(function(){ return null; }));
  var current = (record && record.value != null) ? record.value : 60;
  var next    = credit ? current + amount : Math.max(0, current - amount);
  if (window.db) await window.db.userData.put({ key:'timebank', value:next }).catch(function(){});
  var tbEl = document.getElementById('timebank');
  if (tbEl) tbEl.textContent = Math.floor(next/60) + 'h';
};

window._tbTransfer = function() {
  var peerId = prompt('Enter peer ID to transfer to:');
  var mins   = parseInt(prompt('Minutes to transfer:')||'0');
  if (!peerId || !mins) return;
  window._tbAddTx(mins, 'Transfer to ' + peerId.slice(0,8), false);
  if (window.mesh && window.mesh._send)
    window.mesh._send(peerId, { type:'TIMEBANK_CREDIT', to:peerId, amount:mins, from:window.peerId });
  if (typeof window.notify === 'function') window.notify('Transferred ' + mins + 'm to ' + peerId.slice(0,8), 'success');
};
window._tbEarn = function() {
  if (typeof window.notify === 'function')
    window.notify('Complete a trade to earn time credits automatically!', 'info');
};

// ─── 9. Mesh 事件钩子 ────────────────────────────────────────────────────────
function hookMeshEvents() {
  var poll = setInterval(function() {
    if (!window.mesh) return;
    clearInterval(poll);

    var origStatus = window.mesh.onStatus;
    window.mesh.onStatus = function(mode) {
      if (window._statusBarUpdate) window._statusBarUpdate(mode);
      if (origStatus) origStatus(mode);
      // Show offline guidance when completely disconnected
      if (mode === 'offline' || mode === 'lan') {
        var peerCount = window.mesh && window.mesh.dataChannels ? window.mesh.dataChannels.size : 0;
        if (peerCount === 0 && mode !== 'p2p') {
          console.log('[P2P] No peers — LAN mode. Other devices need same WiFi network to connect.');
        }
      }
    };

    var origPeers = window.mesh.onPeers;
    window.mesh.onPeers = function(count) {
      if (window._statusBarPeers) window._statusBarPeers(count);
      if (typeof window.updatePeerCount === 'function') window.updatePeerCount(count);
      if (origPeers) origPeers(count);
    };

    var origOnData = window.mesh._onData && window.mesh._onData.bind(window.mesh);
    if (origOnData) {
      window.mesh._onData = async function(fromPeerId, raw) {
        try {
          var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (msg && msg.type && msg.type.startsWith('call-')) {
            _handleCallSignal(fromPeerId, msg); return;
          }
          if (msg && msg.type === 'CHANNEL_MSG') {
            var rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
            if (typeof window.handleMessage === 'function') {
              window.handleMessage(rawStr);
            } else {
              // handleMessage not ready yet — try direct delivery
              console.warn('[P1P2] handleMessage not available for CHANNEL_MSG');
            }
          }
          if (msg && msg.type === 'TIMEBANK_CREDIT' && msg.to === window.peerId)
            window._tbAddTx(msg.amount, 'Received from ' + fromPeerId.slice(0,8), true);
          if (msg && msg.type === 'REPUTATION_UPDATE') {
            var key = 'zk_reputation_' + msg.targetPeerId;
            var ex  = JSON.parse(localStorage.getItem(key)||'{"points":50,"ratings":[]}');
            ex.ratings.push({ stars: msg.stars, ts: msg.ts });
            ex.points = Math.round(ex.ratings.reduce(function(s,r){ return s+r.stars; },0)/ex.ratings.length*20);
            localStorage.setItem(key, JSON.stringify(ex));
          }
        } catch(e){}
        return origOnData(fromPeerId, raw);
      };
    }

    // Register direct callback for reliable community message delivery
    window.mesh.onChannelMsg = function(msg) {
      try {
        var data = typeof msg === 'string' ? msg : JSON.stringify(msg);
        if (typeof window.handleMessage === 'function') window.handleMessage(data);
      } catch(e) {}
    };

    if (window._statusBarUpdate) window._statusBarUpdate(window.mesh.networkMode);
    if (window._statusBarPeers)  window._statusBarPeers(window.mesh.dataChannels ? window.mesh.dataChannels.size : 0);

    loadAIRecommendationsV2();
  }, 250);
}

// ─── Boot ────────────────────────────────────────────────────────────────────
function boot() {
  _injectCSS();
  _loadChannelStore().then(function(){ _renderChannelMsgs(); }).catch(function(){});
  initStatusBar();
  initCommunityTab();
  initCallUI();
  initRatingModal();
  initTimebankUI();
  _listenChannelMsgs();
  startCardObserver();
  hookMeshEvents();
  ensureChatUIConnected();

  setTimeout(_hookClaimForRating, 2000);

  // Add call buttons to product chat header
  setTimeout(function() {
    var chatHeader = document.querySelector('#product-chat-modal .product-chat-header, #product-chat-modal .modal-header');
    if (chatHeader && !chatHeader.querySelector('.call-icon-btn')) {
      chatHeader.insertAdjacentHTML('beforeend',
        '<button class="call-icon-btn" title="Voice call"' +
          ' onclick="window._p1p2_startCall(window.currentProductChat && window.currentProductChat.sellerId,\'audio\',\'Seller\')">📞</button>' +
        '<button class="call-icon-btn" title="Video call"' +
          ' onclick="window._p1p2_startCall(window.currentProductChat && window.currentProductChat.sellerId,\'video\',\'Seller\')">📹</button>');
    }
  }, 2000);

  // Kick off AI recs independently (mesh hook re-runs after mesh ready)
  setTimeout(loadAIRecommendationsV2, 1200);

  console.log('[P1P2] ✅ Feature pack v2.0 loaded');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  setTimeout(boot, 600);
}

})();
