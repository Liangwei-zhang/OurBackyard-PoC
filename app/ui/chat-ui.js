/**
 * ChatUI v5.0 — Production stable
 * - Bottom tab bar navigation (replaces FAB menu)
 * - Crash-hardened: all DOM access null-guarded
 * - Android call permission flow
 * - WhatsApp-style thread UX
 */

const ChatUI = (() => {
  'use strict';

  let _mesh, _db, _myPeerId;
  let _currentChat = null;
  let _unread = new Map();
  let _recorder = null, _recChunks = [], _recTimer = null, _recInterval = null;

  const _EMOJIS = '😀 😂 🥰 😎 🤔 😮 😢 😡 🤗 👍 👎 ❤️ 🔥 ⭐ ✅ 💯 🙏 👋 🎉 🎁 🏠 🛒 📦 🌱 ☕ 💪 🤝 👏 💡 🚀 🌈 😊 🥲 😅 🤦 💀 🫶 🙌 😴 🤯'.split(' ');

  // ── Safe DOM accessor (never throws) ────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function $$(id) {
    try { return document.getElementById(id); } catch { return null; }
  }

  function _safe(id, fn) {
    try { const el = document.getElementById(id); if (el) fn(el); } catch(e) { console.warn('[ChatUI] DOM err on #' + id + ':', e.message); }
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function init(mesh, db, myPeerId) {
    _mesh = mesh;
    _db = db;
    _myPeerId = myPeerId;
    try {
      _injectStyles();
      _buildDOM();
      _bindEvents();
      mesh.onChat = _onIncoming;
      console.log('[ChatUI] v5.0 ready');
    } catch(e) {
      console.error('[ChatUI] init failed:', e);
    }
  }

  // ── Public ──────────────────────────────────────────────────────────────────
  function openWithSeller(itemId, sellerId, sellerName, itemData) {
    if (!sellerId) return;
    _currentChat = {
      peerId:  sellerId,
      itemId:  itemId || null,
      name:    sellerName || OBUtils.shortId(sellerId),
      item:    itemData || null,   // full item object if available
    };
    // If no itemData passed, try to load it from DB
    if (!_currentChat.item && itemId && _db && _db.items) {
      _db.items.get(Number(itemId) || itemId).then(item => {
        if (item) { _currentChat.item = item; _renderItemBanner(item); }
      }).catch(() => {});
    }
    _open();
    _loadThread(sellerId, itemId || null);
  }

  function openInbox() {
    _currentChat = null;
    _open();
    _loadInbox();
  }

  // ── Incoming ────────────────────────────────────────────────────────────────
  function _onIncoming(msg) {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'read') { _markRead(msg.msgId); return; }
      if (msg.direction !== 'in') return;
      if (msg.text) msg.text = String(msg.text).slice(0, 4000);
      if (msg.from) msg.from = String(msg.from).slice(0, 50);

      _unread.set(msg.from, (_unread.get(msg.from) || 0) + 1);
      _syncBadge();

      const modal = $('ob-chat-modal');
      const isOpen = modal && modal.classList.contains('open');
      const inThread = isOpen && _currentChat && _currentChat.peerId === msg.from;

      if (inThread) {
        _appendBubble(msg);
        if (_mesh && _mesh._send) _mesh._send(msg.from, { type: 'CHAT_READ', msgId: msg.id, ts: Date.now() });
        _unread.set(msg.from, 0);
        _syncBadge();
      } else {
        _showToast(msg);
        const inbox = $('ob-inbox');
        if (isOpen && inbox && inbox.style.display !== 'none') _loadInbox();
      }
    } catch(e) { console.warn('[ChatUI] _onIncoming error:', e.message); }
  }

  // ── Modal open ──────────────────────────────────────────────────────────────
  function _open() {
    try {
      const modal = $('ob-chat-modal');
      if (!modal) return;
      modal.classList.add('open');
      if (_currentChat) _showThread(); else _showInbox();
    } catch(e) { console.warn('[ChatUI] _open error:', e.message); }
  }

  function _close() {
    try {
      const modal = $('ob-chat-modal');
      if (modal) modal.classList.remove('open');
      _stopRecording(false);
      _hideEmoji();
    } catch(e) {}
  }

  function _showInbox() {
    _safe('ob-view-inbox', el => el.style.display = 'flex');
    _safe('ob-view-thread', el => el.style.display = 'none');
  }

  function _showThread() {
    _safe('ob-view-inbox', el => el.style.display = 'none');
    _safe('ob-view-thread', el => el.style.display = 'flex');

    const name = (_currentChat && _currentChat.name) || OBUtils.shortId(_currentChat && _currentChat.peerId);
    _safe('ob-th-name', el => el.textContent = name);
    _safe('ob-th-avatar', el => {
      el.textContent = (name[0] || '?').toUpperCase();
      el.style.background = OBUtils.avatarColor(_currentChat && _currentChat.peerId);
    });
    _safe('ob-th-status', el => {
      const isOnline = window.mesh && window.mesh.dataChannels && window.mesh.dataChannels.has(_currentChat.peerId);
      el.innerHTML = isOnline
        ? '<span class="ob-dot-online"></span>Online'
        : (_currentChat.itemId ? '📦 Item #' + String(_currentChat.itemId).slice(0, 6) : 'Tap to start chatting');
    });

    _unread.set(_currentChat.peerId, 0);
    _syncBadge();
    // Render item banner if we have item data
    if (_currentChat.item) {
      _renderItemBanner(_currentChat.item);
    } else {
      // Hide banner if no item context (peer-to-peer chat)
      _safe('ob-item-banner', el => el.style.display = 'none');
    }
  }

  // ── Inbox ───────────────────────────────────────────────────────────────────

  // ── Item context banner ─────────────────────────────────────────────────────
  function _renderItemBanner(item) {
    try {
      const banner = $('ob-item-banner');
      if (!banner || !item) return;

      const price = item.price === 0 || item.price === '0'
        ? '<span style="color:#22c55e">🎁 Free</span>'
        : item.price === 'swap'
        ? '<span style="color:#f59e0b">☕ Swap</span>'
        : item.price ? '<span style="color:#22c55e">$' + Number(item.price).toFixed(2) + '</span>' : '';

      const statusColor = { available: '#22c55e', pending: '#f59e0b', gone: '#888' };
      const statusLabel = { available: '● Available', pending: '⏳ Pending', gone: '✓ Gone' };
      const status = item.status || 'available';

      // Get image hash for thumbnail
      const hash = (item.imageHashes && item.imageHashes[0]) || item.imageHash || '';

      banner.innerHTML =
        '<div class="ob-banner-img-wrap">' +
          (hash
            ? '<img id="ob-banner-thumb" class="ob-banner-thumb" src="" alt="' + OBUtils.esc(item.title) + '" onerror="this.style.display=&quot;none&quot;">'
            : '<div class="ob-banner-no-img">📷</div>') +
        '</div>' +
        '<div class="ob-banner-info">' +
          '<div class="ob-banner-title">' + OBUtils.esc(item.title || '') + '</div>' +
          '<div class="ob-banner-meta">' +
            price +
            (item.condition ? ' · <span style="opacity:.7">' + OBUtils.esc(item.condition) + '</span>' : '') +
          '</div>' +
          '<div class="ob-banner-status" style="color:' + (statusColor[status] || '#888') + ';font-size:11px;margin-top:2px">' +
            (statusLabel[status] || '') +
          '</div>' +
        '</div>' +
        '<button class="ob-banner-view" onclick="window._obViewBannerItem && window._obViewBannerItem()" aria-label="View item">›</button>';

      banner.style.display = 'flex';

      // Load thumbnail from blob DB
      if (hash && _db && _db.blobs) {
        _db.blobs.where('hash').equals(hash).first().then(blob => {
          if (!blob || !blob.blob) return;
          const url = URL.createObjectURL(blob.blob);
          const img = $('ob-banner-thumb');
          if (img) { img.src = url; img.onload = () => {}; }
        }).catch(() => {});
      }

      // Wire view button
      window._obViewBannerItem = function() {
        if (window.showItemDetail && _currentChat && _currentChat.itemId) {
          _close();
          window.showItemDetail(_currentChat.itemId);
        }
      };
    } catch(e) { console.warn('[ChatUI] banner error:', e.message); }
  }

  async function _loadInbox() {
    try {
      const shopEl = $('ob-inbox-shopping');
      const pplEl  = $('ob-inbox-people');
      if (!shopEl) return;
      shopEl.innerHTML = _skeleton(3);
      if (pplEl) pplEl.innerHTML = _skeleton(2);

      const online = (_mesh && _mesh.dataChannels)
        ? Array.from(_mesh.dataChannels.keys()).filter(p => p !== _myPeerId)
        : [];
      const onlineSet = new Set(online);

      // Load all messages
      const allMsgs = (_db && _db.chatMessages)
        ? await _db.chatMessages.orderBy('ts').reverse().limit(200).toArray().catch(() => [])
        : [];

      // Group by conversation partner, keep latest message
      const convos = new Map(); // peerId → last message
      allMsgs.forEach(m => {
        const pid = m.direction === 'out' ? m.to : m.from;
        if (pid && !convos.has(pid)) convos.set(pid, m);
      });

      // Separate: shopping (has itemId) vs people (no itemId)
      const shopConvos = new Map(), pplConvos = new Map();
      convos.forEach((msg, pid) => {
        if (msg.itemId) shopConvos.set(pid, msg); else pplConvos.set(pid, msg);
      });

      // Also add online-only peers (no history yet) to People tab
      online.forEach(pid => {
        if (!convos.has(pid)) pplConvos.set(pid, null); // null = online, no history
      });

      // ── Shopping tab ──────────────────────────────────────────────────────
      let shopHtml = '';
      let shopUnread = 0;

      if (shopConvos.size === 0) {
        shopHtml = '<div class="ob-empty" style="padding:40px 24px">' +
          '<div style="font-size:48px">🛒</div>' +
          '<div class="ob-empty-title">No shopping chats yet</div>' +
          '<div class="ob-empty-sub">Browse items and tap<br><b>Ask Seller</b> to start a deal</div>' +
          '</div>';
      } else {
        // Load item details for shopping conversations
        const itemIds = Array.from(shopConvos.values()).map(m => m.itemId).filter(Boolean);
        const itemMap = new Map();
        if (_db && _db.items && itemIds.length) {
          const items = await _db.items.where('id').anyOf(itemIds.map(Number)).toArray().catch(() => []);
          items.forEach(it => itemMap.set(it.id, it));
          // Also try string IDs
          itemIds.forEach(id => { if (!itemMap.has(Number(id))) itemMap.set(String(id), null); });
        }

        shopConvos.forEach((last, pid) => {
          const u = _unread.get(pid) || 0;
          shopUnread += u;
          const item = itemMap.get(Number(last.itemId)) || itemMap.get(last.itemId);
          shopHtml += _shopRow(pid, last, item, u, onlineSet.has(pid));
        });
      }

      shopEl.innerHTML = shopHtml;
      _bindRows(shopEl, shopConvos);
      _loadShopThumbs(shopEl).catch(() => {});

      // ── People tab ────────────────────────────────────────────────────────
      let pplHtml = '';
      let pplUnread = 0;

      if (online.length > 0 && pplConvos.size > 0) {
        pplHtml += '<div class="ob-list-hdr">🟢 Online Neighbors</div>';
      }

      if (pplConvos.size === 0) {
        pplHtml = '<div class="ob-empty" style="padding:40px 24px">' +
          '<div style="font-size:48px">💬</div>' +
          '<div class="ob-empty-title">No private chats yet</div>' +
          '<div class="ob-empty-sub">When neighbors are online<br>you can start a private chat</div>' +
          '</div>';
      } else {
        pplConvos.forEach((last, pid) => {
          const u = _unread.get(pid) || 0;
          pplUnread += u;
          const isOnline = onlineSet.has(pid);
          pplHtml += _peopleRow(pid, last, u, isOnline);
        });
      }

      if (pplEl) pplEl.innerHTML = pplHtml;
      if (pplEl) _bindRows(pplEl, pplConvos);

      // Update pill badges
      const shopBadge = $('ob-pill-shop-badge');
      const pplBadge  = $('ob-pill-ppl-badge');
      if (shopBadge) { shopBadge.textContent = shopUnread > 99 ? '99+' : shopUnread; shopBadge.style.display = shopUnread > 0 ? 'inline-flex' : 'none'; }
      if (pplBadge)  { pplBadge.textContent  = pplUnread  > 99 ? '99+' : pplUnread;  pplBadge.style.display  = pplUnread  > 0 ? 'inline-flex' : 'none'; }

    } catch(e) { console.warn('[ChatUI] _loadInbox error:', e.message); }
  }

  // ── Shopping row: item image + title + price + last message ─────────────────
  function _shopRow(pid, last, item, unread, isOnline) {
    const bg  = OBUtils.avatarColor(pid);
    const ini = OBUtils.shortId(pid, 1).toUpperCase();
    const preview = last.direction === 'out' ? '→ ' + _mediaPreview(last) : _mediaPreview(last);

    const price = !item ? '' : (
      item.price === 0 || item.price === '0' ? '<span class="ob-shop-price free">🎁 Free</span>' :
      item.price === 'swap' ? '<span class="ob-shop-price swap">☕ Swap</span>' :
      item.price ? '<span class="ob-shop-price">$' + Number(item.price).toFixed(2) + '</span>' : ''
    );
    const statusDot = !item ? '' : (
      item.status === 'available' ? '<span class="ob-shop-status avail">● Available</span>' :
      item.status === 'pending'   ? '<span class="ob-shop-status pend">⏳ Pending</span>' :
      '<span class="ob-shop-status gone">✓ Gone</span>'
    );
    const itemTitle  = item ? OBUtils.esc(item.title || '') : 'Unknown item';
    const itemHash   = item ? ((item.imageHashes && item.imageHashes[0]) || item.imageHash || '') : '';
    const isMine     = last.from === _myPeerId || last.direction === 'out';
    const role       = isMine ? (item && item.sellerId === _myPeerId ? 'Seller' : 'Buyer') : 'Seller';

    return (
      '<div class="ob-shop-row" data-peer="' + OBUtils.esc(pid) + '" data-item="' + OBUtils.esc(last.itemId || '') + '">' +
        // Left: item thumbnail
        '<div class="ob-shop-thumb-wrap">' +
          (itemHash
            ? '<img class="ob-shop-thumb" data-hash="' + OBUtils.esc(itemHash) + '" src="" alt="' + itemTitle + '">'
            : '<div class="ob-shop-thumb-placeholder">📦</div>') +
          (isOnline ? '<span class="ob-shop-online-dot"></span>' : '') +
        '</div>' +
        // Right: content
        '<div class="ob-shop-body">' +
          '<div class="ob-shop-item-title">' + itemTitle + '</div>' +
          '<div class="ob-shop-item-meta">' + price + statusDot + '</div>' +
          '<div class="ob-shop-divider"></div>' +
          '<div class="ob-shop-peer-row">' +
            '<div class="ob-mini-avatar" style="background:' + bg + '">' + ini + '</div>' +
            '<div class="ob-shop-peer-info">' +
              '<span class="ob-shop-role">' + role + '</span>' +
              (unread > 0 ? '<span class="ob-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
            '</div>' +
            '<div class="ob-shop-preview">' + OBUtils.esc(preview) + '</div>' +
            '<div class="ob-shop-time">' + OBUtils.relTime(last.ts) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // ── People row: private chat with neighbor ───────────────────────────────────
  function _peopleRow(pid, last, unread, isOnline) {
    const bg   = OBUtils.avatarColor(pid);
    const ini  = OBUtils.shortId(pid, 1).toUpperCase();
    const name = OBUtils.shortId(pid);
    const preview  = last ? (last.direction === 'out' ? '→ ' + _mediaPreview(last) : _mediaPreview(last)) : 'Online — tap to chat';
    const timeStr  = last ? OBUtils.relTime(last.ts) : 'now';

    return (
      '<div class="ob-inbox-row' + (isOnline ? ' ob-row-online' : '') + '" data-peer="' + OBUtils.esc(pid) + '" data-item="">' +
        '<div class="ob-avatar" style="background:' + bg + ';position:relative">' + ini +
          (isOnline ? '<span class="ob-dot-online" style="position:absolute;bottom:0;right:0"></span>' : '') +
        '</div>' +
        '<div class="ob-inbox-info">' +
          '<div class="ob-inbox-name">' +
            '<span class="ob-private-tag">Private</span>' +
            'Chat with ' + OBUtils.esc(name) +
            (unread > 0 ? '<span class="ob-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
          '</div>' +
          '<div class="ob-inbox-preview">' + OBUtils.esc(preview) + '</div>' +
        '</div>' +
        '<div class="ob-inbox-meta">' + timeStr + '</div>' +
      '</div>'
    );
  }

  // ── Bind click handlers to rows ──────────────────────────────────────────────
  // ── Load thumbnails for shopping rows after render ─────────────────────────
  async function _loadShopThumbs(container) {
    if (!container || !_db || !_db.blobs) return;
    const imgs = container.querySelectorAll('img.ob-shop-thumb[data-hash]');
    for (const img of imgs) {
      const hash = img.dataset.hash;
      if (!hash) continue;
      try {
        const blob = await _db.blobs.where('hash').equals(hash).first();
        if (blob && blob.blob) {
          const url = URL.createObjectURL(blob.blob);
          img.src = url;
          img.onload = () => img.classList.add('loaded');
          img.onerror = () => { img.style.display = 'none'; img.nextElementSibling && (img.nextElementSibling.style.display = 'flex'); };
        } else {
          img.style.display = 'none';
        }
      } catch {}
    }
  }

    function _bindRows(container, convosMap) {
    if (!container) return;
    container.querySelectorAll('[data-peer]').forEach(el => {
      el.onclick = () => {
        const pid    = el.dataset.peer;
        const itemId = el.dataset.item || null;
        const last   = convosMap && convosMap.get(pid);
        const name   = OBUtils.shortId(pid);
        _currentChat = { peerId: pid, itemId, name };
        // Try to load item from _currentDetailItem or DB
        if (itemId && _db && _db.items) {
          _db.items.get(Number(itemId) || itemId).then(item => {
            if (item) { _currentChat.item = item; _renderItemBanner(item); }
          }).catch(() => {});
        }
        _showThread();
        _loadThread(pid, itemId);
      };
    });
  }

  function _inboxRow(pid, itemId, preview, time, unread, isOnline, hasDot) {
    const bg = OBUtils.avatarColor(pid);
    const ini = OBUtils.shortId(pid, 1).toUpperCase();
    return `<div class="ob-inbox-row${isOnline ? ' ob-row-online' : ''}" data-peer="${OBUtils.esc(pid)}" data-item="${OBUtils.esc(itemId || '')}">
      <div class="ob-avatar" style="background:${bg};position:relative">${ini}${hasDot ? '<span class="ob-dot-online" style="position:absolute;bottom:0;right:0"></span>' : ''}</div>
      <div class="ob-inbox-info">
        <div class="ob-inbox-name">${OBUtils.esc(OBUtils.shortId(pid))}${unread > 0 ? `<span class="ob-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
        <div class="ob-inbox-preview">${OBUtils.esc(preview)}</div>
      </div>
      <div class="ob-inbox-meta">${time}</div>
    </div>`;
  }

  function _mediaPreview(msg) {
    if (msg.mediaType === 'image') return '📷 Photo';
    if (msg.mediaType === 'audio') return '🎤 Voice';
    return (msg.text || '').slice(0, 45) || '…';
  }

  // ── Thread ──────────────────────────────────────────────────────────────────
  async function _loadThread(peerId, itemId) {
    try {
      const container = $('ob-messages');
      if (!container) return;
      container.innerHTML = _skeleton(5, true);

      if (!_db || !_db.chatMessages) {
        container.innerHTML = '<div class="ob-empty"><div style="font-size:40px">✉️</div><div class="ob-empty-title">Say hello!</div></div>';
        return;
      }

      let msgs = await _db.chatMessages.where('from').anyOf([peerId, _myPeerId]).toArray().catch(() => []);
      msgs = msgs.filter(m => (m.from === peerId && m.to === _myPeerId) || (m.from === _myPeerId && m.to === peerId));
      if (itemId != null) msgs = msgs.filter(m => !m.itemId || String(m.itemId) === String(itemId));
      msgs.sort((a, b) => a.ts - b.ts);

      container.innerHTML = '';
      if (!msgs.length) {
        container.innerHTML = '<div class="ob-empty"><div style="font-size:40px">✉️</div><div class="ob-empty-title">Say hello! 👋</div></div>';
      } else {
        let lastDay = null;
        msgs.forEach(m => {
          const day = new Date(m.ts).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
          if (day !== lastDay) { container.insertAdjacentHTML('beforeend', `<div class="ob-day-sep">${day}</div>`); lastDay = day; }
          _appendBubble(m, false);
        });
      }
      container.scrollTop = container.scrollHeight;
    } catch(e) { console.warn('[ChatUI] _loadThread error:', e.message); }
  }

  function _appendBubble(msg, scroll = true) {
    try {
      const container = $('ob-messages');
      if (!container) return;
      container.querySelector('.ob-empty, .ob-skeleton')?.remove();

      const mine = msg.from === _myPeerId || msg.direction === 'out';
      const status = mine ? `<span class="ob-status${msg.status === 'sending' ? ' sending' : ''}">${msg.read ? '✓✓' : '✓'}</span>` : '';

      let body = '';
      if (msg.mediaType === 'image' && msg.mediaData) {
        body = `<img src="${msg.mediaData}" class="ob-media-img" loading="lazy" alt="Photo" onclick="this.requestFullscreen?.()">`;
      } else if (msg.mediaType === 'audio' && msg.mediaData) {
        body = `<audio controls src="${msg.mediaData}" class="ob-media-audio" preload="metadata"></audio>`;
      } else {
        body = `<span class="ob-btext">${OBUtils.esc(msg.text || '')}</span>`;
      }

      const div = document.createElement('div');
      div.className = 'ob-bubble-wrap ' + (mine ? 'mine' : 'theirs');
      div.dataset.msgId = msg.id || '';
      div.innerHTML = `<div class="ob-bubble">${body}<div class="ob-bfoot">${OBUtils.relTime(msg.ts)}${status}</div></div>`;
      container.appendChild(div);
      if (scroll) container.scrollTop = container.scrollHeight;
    } catch(e) { console.warn('[ChatUI] _appendBubble error:', e.message); }
  }

  function _markRead(msgId) {
    try {
      const el = document.querySelector(`[data-msg-id="${msgId}"] .ob-status`);
      if (el) { el.textContent = '✓✓'; el.classList.remove('sending'); }
    } catch {}
  }

  // ── Send text ───────────────────────────────────────────────────────────────
  async function _sendText() {
    try {
      const input = $('ob-input');
      if (!input || !_currentChat || !_mesh) return;
      const text = input.value.trim();
      if (!text) return;
      if (text.length > 4000) { OBUtils.notify('Message too long (max 4000 chars)', 'warning'); return; }

      const sendBtn = $('ob-send-btn');
      if (sendBtn) sendBtn.disabled = true;
      input.value = '';
      input.style.height = 'auto';
      _hideEmoji();
      OBUtils.haptic('light');

      const opt = _optimistic({ text, status: 'sending' });
      _appendBubble(opt);

      _mesh.sendChat(_currentChat.peerId, text, _currentChat.itemId || null)
        .then(() => _updateStatus(opt.id, '✓'))
        .catch(e => { console.warn('[ChatUI]', e.message); _updateStatus(opt.id, '✓'); })
        .finally(() => { if (sendBtn) sendBtn.disabled = false; input.focus(); });
    } catch(e) { console.error('[ChatUI] _sendText error:', e.message); }
  }

  // ── Send image ──────────────────────────────────────────────────────────────
  async function _sendImage(file) {
    try {
      if (!file || !_currentChat || !_mesh) return;
      const allowed = ['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif'];
      if (!file.type.startsWith('image/') && !allowed.includes(file.type)) { OBUtils.notify('Only images can be sent', 'warning'); return; }
      if (file.size > 8 * 1024 * 1024) { OBUtils.notify('Image too large (max 8MB)', 'error'); return; }

      OBUtils.haptic('light');
      const dataUrl = await OBUtils.compressImage(file, { maxDim: 900, quality: 0.78, maxSizeKB: 280 });
      const opt = _optimistic({ mediaType: 'image', mediaData: dataUrl, text: '[photo]', status: 'sending' });
      _appendBubble(opt);
      _mesh.sendChat(_currentChat.peerId, '[photo]', _currentChat.itemId || null, { mediaType: 'image', mediaData: dataUrl })
        .then(() => _updateStatus(opt.id, '✓'))
        .catch(e => { console.warn('[ChatUI]', e.message); _updateStatus(opt.id, '✓'); });
    } catch(e) { OBUtils.notify('Could not send image', 'error'); console.error('[ChatUI] image error:', e); }
  }

  // ── Voice recording ─────────────────────────────────────────────────────────
  async function _toggleRecording() {
    if (_recorder) { _stopRecording(true); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { OBUtils.notify('Microphone permission denied', 'error'); return; }

    _recChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    _recorder = new MediaRecorder(stream, { mimeType: mime });
    _recorder.ondataavailable = e => e.data.size > 0 && _recChunks.push(e.data);
    _recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(_recChunks, { type: mime });
      const reader = new FileReader();
      reader.onload = () => _sendVoice(reader.result);
      reader.readAsDataURL(blob);
      _recChunks = [];
    };
    _recorder.start(100);
    _safe('ob-voice-btn', btn => { btn.textContent = '⏹'; btn.style.background = '#E24B4A'; btn.style.color = '#fff'; });
    _safe('ob-rec-bar', el => el.style.display = 'flex');

    let secs = 0;
    _recInterval = setInterval(() => {
      secs++;
      _safe('ob-rec-bar', el => el.innerHTML = `<span style="color:#E24B4A">🔴 ${secs}s</span><span style="color:var(--text-muted,#888)">&nbsp;/ 20s</span>`);
      if (secs >= 20) _stopRecording(true);
    }, 1000);
    _recTimer = setTimeout(() => _stopRecording(true), 20000);
    OBUtils.haptic('medium');
  }

  function _stopRecording(send = true) {
    clearTimeout(_recTimer); clearInterval(_recInterval);
    _recTimer = _recInterval = null;
    _safe('ob-voice-btn', btn => { btn.textContent = '🎤'; btn.style.background = ''; btn.style.color = ''; });
    _safe('ob-rec-bar', el => el.style.display = 'none');
    if (_recorder && _recorder.state !== 'inactive') {
      if (!send) { _recorder.stream?.getTracks().forEach(t => t.stop()); _recChunks = []; }
      _recorder.stop();
    }
    _recorder = null;
  }

  function _sendVoice(dataUrl) {
    if (!_currentChat || !_mesh) return;
    OBUtils.haptic('success');
    const opt = _optimistic({ mediaType: 'audio', mediaData: dataUrl, text: '[voice]', status: 'sending' });
    _appendBubble(opt);
    _mesh.sendChat(_currentChat.peerId, '[voice]', _currentChat.itemId || null, { mediaType: 'audio', mediaData: dataUrl })
      .then(() => _updateStatus(opt.id, '✓'))
      .catch(e => { console.warn('[ChatUI]', e.message); _updateStatus(opt.id, '✓'); });
  }

  // ── Emoji ────────────────────────────────────────────────────────────────────
  function _toggleEmoji() {
    const p = $('ob-emoji-panel');
    if (!p) return;
    p.style.display = p.style.display === 'grid' ? 'none' : 'grid';
  }

  function _hideEmoji() {
    const p = $('ob-emoji-panel');
    if (p) p.style.display = 'none';
  }

  function _insertEmoji(e) {
    const inp = $('ob-input');
    if (!inp) return;
    const pos = inp.selectionStart || 0;
    inp.value = inp.value.slice(0, pos) + e + inp.value.slice(inp.selectionEnd || pos);
    inp.setSelectionRange(pos + e.length, pos + e.length);
    inp.focus();
    _hideEmoji();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function _optimistic(fields) {
    return { id: 'opt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      from: _myPeerId, to: _currentChat && _currentChat.peerId, ts: Date.now(), direction: 'out', ...fields };
  }

  function _updateStatus(msgId, icon) {
    try {
      const el = document.querySelector(`[data-msg-id="${msgId}"] .ob-status`);
      if (el) { el.textContent = icon; el.classList.remove('sending'); }
    } catch {}
  }

  function _showToast(msg) {
    try {
      const preview = msg.mediaType === 'image' ? '📷 Photo' : msg.mediaType === 'audio' ? '🎤 Voice' : (msg.text || '').slice(0, 50);
      const t = document.createElement('div');
      t.className = 'ob-toast-notif';
      t.innerHTML = `<div class="ob-toast-av" style="background:${OBUtils.avatarColor(msg.from)}">${OBUtils.shortId(msg.from, 1).toUpperCase()}</div>
        <div><div style="font-weight:600;font-size:13px">${OBUtils.esc(OBUtils.shortId(msg.from))}</div>
        <div style="font-size:12px;opacity:.8;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${OBUtils.esc(preview)}</div></div>`;
      t.onclick = () => { openWithSeller(msg.itemId, msg.from, OBUtils.shortId(msg.from)); t.remove(); };
      document.body.appendChild(t);
      setTimeout(() => { try { t.style.animation = 'ob-toast-out .2s ease forwards'; setTimeout(() => t.remove(), 200); } catch {} }, 4000);
    } catch {}
  }

  function _syncBadge() {
    try {
      const total = Array.from(_unread.values()).reduce((a, b) => a + b, 0);
      // Update bottom tab badge
      const tabBadge = $('ob-tab-msg-badge');
      if (tabBadge) { tabBadge.textContent = total > 99 ? '99+' : String(total); tabBadge.style.display = total > 0 ? 'flex' : 'none'; }
      // Legacy FAB badge compat
      // Update bottom tab badge (primary) and legacy FAB compat
      if (typeof window._fabUpdateUnread === 'function') window._fabUpdateUnread(total);
      // Direct update as fallback if bottom tabs not yet ready
      const tabBadge2 = document.getElementById('ob-tab-msg-badge');
      if (tabBadge2) { tabBadge2.textContent = total > 99 ? '99+' : String(total || 0); tabBadge2.style.display = total > 0 ? 'flex' : 'none'; }
    } catch {}
  }

  function _skeleton(count, isBubbles = false) {
    if (isBubbles) return Array.from({length:count},(_, i)=>`<div class="ob-skel-bubble${i%2?' ob-skel-mine':''}"><div class="ob-skel-line" style="width:${60+Math.random()*30}%"></div></div>`).join('');
    return Array.from({length:count},()=>`<div class="ob-skel-row"><div class="ob-skel-av"></div><div style="flex:1"><div class="ob-skel-line" style="width:55%"></div><div class="ob-skel-line" style="width:75%;margin-top:6px"></div></div></div>`).join('');
  }

  // ── Events ───────────────────────────────────────────────────────────────────
  function _bindEvents() {
    _safe('ob-send-btn', el => el.onclick = _sendText);
    _safe('ob-input', el => {
      el.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendText(); } };
      el.oninput = function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 132) + 'px'; _hideEmoji(); };
    });
    _safe('ob-back-btn', el => el.onclick = () => { _currentChat = null; _showInbox(); _loadInbox(); });
    const doClose = () => _close();
    _safe('ob-close1', el => el.onclick = doClose);
    _safe('ob-close2', el => el.onclick = doClose);

    const imgIn = $('ob-img-input'), camIn = $('ob-cam-input');
    if (imgIn) imgIn.onchange = e => { if (e.target.files[0]) _sendImage(e.target.files[0]); e.target.value=''; };
    if (camIn) camIn.onchange = e => { if (e.target.files[0]) _sendImage(e.target.files[0]); e.target.value=''; };
    _safe('ob-btn-img', el => el.onclick = () => imgIn && imgIn.click());
    _safe('ob-btn-cam', el => el.onclick = () => camIn && camIn.click());
    _safe('ob-voice-btn', el => el.onclick = _toggleRecording);
    _safe('ob-btn-emoji', el => el.onclick = _toggleEmoji);

    const picker = $('ob-emoji-panel');
    if (picker) picker.querySelectorAll('.ob-em').forEach(btn => btn.onclick = () => _insertEmoji(btn.dataset.e));

    _safe('ob-btn-vcall', el => el.onclick = () => _call('video'));
    _safe('ob-btn-acall', el => el.onclick = () => _call('audio'));

    // Close on backdrop
    _safe('ob-chat-modal', el => el.onclick = e => { if (e.target.id === 'ob-chat-modal') _close(); });

    // FAB compat (hidden but keep for badge sync)
    _safe('ob-chat-fab', el => el.onclick = openInbox);
  }

  function _call(type) {
    if (!_currentChat) return;
    if (typeof window.startCall === 'function') {
      window.startCall(_currentChat.peerId, type, _currentChat.name || OBUtils.shortId(_currentChat.peerId));
    } else {
      OBUtils.notify('Call feature loading…', 'info');
    }
  }

  // ── DOM build ────────────────────────────────────────────────────────────────
  function _buildDOM() {
    // Hidden FAB for badge compat
    const fab = document.createElement('div');
    fab.id = 'ob-chat-fab';
    fab.innerHTML = '<span id="ob-chat-badge" style="display:none"></span>';
    document.body.appendChild(fab);

    // File inputs
    ['ob-img-input:image/*:', 'ob-cam-input:image/*:environment'].forEach(spec => {
      const [id, accept, capture] = spec.split(':');
      const el = document.createElement('input');
      el.type = 'file'; el.id = id; el.accept = accept; el.style.display = 'none';
      if (capture) el.capture = capture;
      document.body.appendChild(el);
    });

    const emojiHTML = _EMOJIS.map(e => `<button class="ob-em" data-e="${e}">${e}</button>`).join('');

    const modal = document.createElement('div');
    modal.id = 'ob-chat-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Chat');
    modal.innerHTML = `
      <!-- INBOX -->
      <div id="ob-view-inbox" style="display:flex;flex-direction:column;height:100%;overflow:hidden">
        <header class="ob-hdr">
          <div class="ob-hdr-copy">
            <div class="ob-hdr-kicker">Direct communication</div>
            <div class="ob-hdr-title">Messages</div>
          </div>
          <button id="ob-close1" class="ob-icon-btn" aria-label="Close">✕</button>
        </header>
        <!-- Inbox tab selector -->
        <div class="ob-tab-pills">
          <button class="ob-pill active" data-tab="shopping" onclick="_obSwitchInboxTab('shopping')">
            Shopping
            <span class="ob-pill-badge" id="ob-pill-shop-badge" style="display:none">0</span>
          </button>
          <button class="ob-pill" data-tab="people" onclick="_obSwitchInboxTab('people')">
            People
            <span class="ob-pill-badge" id="ob-pill-ppl-badge" style="display:none">0</span>
          </button>
        </div>
        <div id="ob-inbox" style="flex:1;overflow-y:auto">
          <div id="ob-inbox-shopping"></div>
          <div id="ob-inbox-people" style="display:none"></div>
        </div>
      </div>
      <!-- THREAD -->
      <div id="ob-view-thread" style="display:none;flex-direction:column;height:100%;overflow:hidden">
        <header class="ob-hdr">
          <button id="ob-back-btn" class="ob-icon-btn" aria-label="Back" style="font-size:20px">←</button>
          <div id="ob-th-avatar" class="ob-avatar" style="width:36px;height:36px;font-size:14px;flex-shrink:0">?</div>
          <div style="flex:1;min-width:0">
            <div id="ob-th-name" style="font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
            <div id="ob-th-status" class="ob-sub"></div>
          </div>
          <button id="ob-btn-acall" class="ob-icon-btn" aria-label="Voice call" title="Voice call">📞</button>
          <button id="ob-btn-vcall" class="ob-icon-btn" aria-label="Video call" title="Video call">📹</button>
          <button id="ob-close2" class="ob-icon-btn" aria-label="Close">✕</button>
        </header>
        <!-- Item context banner — sticky below thread header -->
        <div id="ob-item-banner" style="display:none;align-items:center;gap:10px;padding:10px 14px;background:var(--bg-card,#1a1a2e);border-bottom:1px solid var(--border,rgba(255,255,255,.07));cursor:pointer;flex-shrink:0" onclick="window._obViewBannerItem && window._obViewBannerItem()"></div>
        <div id="ob-messages" style="flex:1;overflow-y:auto;padding:10px 14px 6px;display:flex;flex-direction:column;gap:2px"></div>
        <div id="ob-rec-bar" style="display:none;justify-content:center;align-items:center;gap:8px;padding:6px 14px;font-size:13px;background:rgba(226,75,74,.08);flex-shrink:0"></div>
        <div id="ob-emoji-panel" style="display:none;grid-template-columns:repeat(8,1fr);gap:1px;padding:8px 12px;background:var(--bg-card,#1a1a2e);border-top:1px solid var(--border,rgba(255,255,255,.06));max-height:130px;overflow-y:auto;flex-shrink:0">${emojiHTML}</div>
        <div class="ob-input-area">
          <div class="ob-tool-row">
            <button id="ob-btn-emoji" class="ob-tool-btn" aria-label="Emoji">😊</button>
            <button id="ob-btn-img"   class="ob-tool-btn" aria-label="Photo">🖼</button>
            <button id="ob-btn-cam"   class="ob-tool-btn" aria-label="Camera">📷</button>
            <button id="ob-voice-btn" class="ob-tool-btn" aria-label="Voice message">🎤</button>
          </div>
          <div class="ob-text-row">
            <textarea id="ob-input" rows="1" placeholder="Type a message…" aria-label="Message" maxlength="4000"></textarea>
            <button id="ob-send-btn" class="ob-send-btn" aria-label="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  // ── CSS ───────────────────────────────────────────────────────────────────────
  function _injectStyles() {
    return;
  }

  // Expose tab switcher globally (called from inline onclick)
  window._obSwitchInboxTab = function(tab) {
    try {
      document.querySelectorAll('.ob-pill').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
      const shop = document.getElementById('ob-inbox-shopping');
      const ppl  = document.getElementById('ob-inbox-people');
      if (shop) shop.style.display = tab === 'shopping' ? 'block' : 'none';
      if (ppl)  ppl.style.display  = tab === 'people'   ? 'block' : 'none';
    } catch(e) {}
  };

  // Refresh inbox if it's currently open (called on peer:joined / peer:left)
  function refresh() {
    try {
      const modal = document.getElementById('ob-chat-modal');
      const isOpen = modal && modal.classList.contains('open');
      if (isOpen && !_currentChat) _loadInbox();
    } catch(e) {}
  }

    return { init, openWithSeller, openInbox, refresh };
})();

if (typeof window !== 'undefined') window.ChatUI = window.ChatUI || ChatUI;
