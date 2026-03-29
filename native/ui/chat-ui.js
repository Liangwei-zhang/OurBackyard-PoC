/**
 * ChatUI v5.0 — Production stable
 * - Bottom tab bar navigation (replaces FAB menu)
 * - Crash-hardened: all DOM access null-guarded
 * - Android call permission flow
 * - WhatsApp-style thread UX
 */

const ChatUI = (() => {
  'use strict';

  let _mesh, _db, _myPeerId, _ps2;
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

  function _chatTable() {
    return _db?.chatMessagesV2 || _db?.chatMessages || null;
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function init(mesh, db, myPeerId) {
    _mesh = mesh;
    _db = db;
    _myPeerId = myPeerId;
    _ps2 = mesh?.ps2 || window.ps2 || null;
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
    // Warm up the peer route as soon as the thread opens so the first message
    // does not get stuck waiting for offer/answer + ECDH exchange.
    _mesh?._kickstartChatRoute?.(sellerId);
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

      // Call signals piggybacked on chat channel — forward to p1p2 call handler
      if (msg._isCallSignal && msg.type && msg.type.startsWith('call-')) {
        if (typeof window._handleCallSignal === 'function') window._handleCallSignal(msg.from, msg);
        else if (typeof _handleCallSignal === 'function') _handleCallSignal(msg.from, msg);
        return;
      }

      if (msg.direction !== 'in') return;
      if (msg.text) msg.text = String(msg.text).slice(0, 4000);
      const senderId = String(msg.senderUserId || msg.from || '').slice(0, 50);
      if (senderId) {
        msg.senderUserId = senderId;
        msg.from = senderId;
      }

      _unread.set(senderId, (_unread.get(senderId) || 0) + 1);
      _syncBadge();

      const modal = $('ob-chat-modal');
      const isOpen = modal && modal.classList.contains('open');
      const inThread = isOpen && _currentChat && _currentChat.peerId === senderId;

      if (inThread) {
        _appendBubble(msg);
        if (_ps2?.im?.markRead && senderId && msg.id) {
          _ps2.im.markRead(senderId, msg.id).catch(() => {});
        } else if (_mesh && _mesh._send) {
          _mesh._send(senderId, { type: 'CHAT_READ', msgId: msg.id, ts: Date.now() });
        }
        _unread.set(senderId, 0);
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
      // Reset bottom tab highlight back to current panel
      const bar = document.getElementById('ob-bottom-tabs');
      if (bar) {
        bar.querySelectorAll('.ob-tab').forEach(t => {
          t.classList.toggle('active', t.dataset.view === 'browse');
          t.setAttribute('aria-selected', t.dataset.view === 'browse');
        });
      }
    } catch(e) {}
  }

  function _showInbox() {
    _safe('ob-view-inbox', el => el.style.display = 'flex');
    _safe('ob-view-thread', el => el.style.display = 'none');
  }

  function _isPeerOnline(peerId) {
    if (!peerId || !_mesh) return false;
    const routePeerId = _mesh.resolvePeerTarget?.(peerId) || peerId;
    if (_mesh.dataChannels?.has(routePeerId)) return true;
    const meta = _mesh.peerMeta?.get?.(routePeerId);
    if (meta && Date.now() - (meta.lastSeen || 0) < 120000) return true;
    if (!_mesh.peerMeta?.entries) return false;
    for (const [, row] of _mesh.peerMeta.entries()) {
      if (!row || Date.now() - (row.lastSeen || 0) >= 120000) continue;
      if ((row.userId || row.peerId) === peerId) return true;
    }
    return false;
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
      const isOnline = _isPeerOnline(_currentChat.peerId);
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

      const directPeers = (_mesh && _mesh.dataChannels)
        ? Array.from(_mesh.dataChannels.keys())
          .map(pid => _mesh.peerMeta?.get?.(pid)?.userId || pid)
          .filter(p => p && p !== _myPeerId)
        : [];
      const announcedPeers = (_mesh && _mesh.peerMeta)
        ? Array.from(_mesh.peerMeta.entries())
          .filter(([, meta]) => meta && Date.now() - (meta.lastSeen || 0) < 120000)
          .map(([pid, meta]) => meta?.userId || pid)
          .filter(p => p && p !== _myPeerId)
        : [];
      const online = [...new Set([...directPeers, ...announcedPeers])];
      const onlineSet = new Set(online);

      // Load all messages
      const chatTable = _chatTable();
      const allMsgs = chatTable
        ? await chatTable.orderBy('ts').reverse().limit(200).toArray().catch(() => [])
        : [];

      // Group by conversation partner, keep latest message
      const convos = new Map(); // peerId → last message
      allMsgs.forEach(m => {
        const sender = m.senderUserId || m.from || null;
        const recipient = m.recipientUserId || m.to || null;
        const pid = m.direction === 'out' ? recipient : sender;
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
    const isMine     = (last.senderUserId || last.from) === _myPeerId || last.direction === 'out';
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

      const chatTable = _chatTable();
      if (!_db || !chatTable) {
        container.innerHTML = '<div class="ob-empty"><div style="font-size:40px">✉️</div><div class="ob-empty-title">Say hello!</div></div>';
        return;
      }

      const myIds = new Set([_myPeerId, window.userId, window.sessionPeerId].filter(Boolean));
      const peerIds = new Set([peerId].filter(Boolean));
      const routePeerId = _mesh?.resolvePeerTarget?.(peerId);
      if (routePeerId) peerIds.add(routePeerId);
      if (_mesh?.peerMeta?.entries) {
        for (const [sid, meta] of _mesh.peerMeta.entries()) {
          if ((meta?.userId || sid) === peerId) peerIds.add(sid);
        }
      }

      let msgs = await chatTable.orderBy('ts').reverse().limit(1200).toArray().catch(() => []);
      msgs = msgs.filter((m) => {
        const fromIds = [m.senderUserId, m.from].filter(Boolean);
        const toIds = [m.recipientUserId, m.to].filter(Boolean);
        const incoming = fromIds.some((id) => peerIds.has(id)) && toIds.some((id) => myIds.has(id));
        const outgoing = fromIds.some((id) => myIds.has(id)) && toIds.some((id) => peerIds.has(id));
        return incoming || outgoing;
      });
      if (itemId != null) {
        // Item thread: strictly show messages bound to this item only.
        msgs = msgs.filter((m) => m.itemId != null && String(m.itemId) === String(itemId));
      } else {
        // Private thread: strictly hide item-bound commerce messages.
        msgs = msgs.filter((m) => m.itemId == null);
      }
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
      // Dedup: if a bubble with this id already exists, skip — UNLESS the new msg
      // has real mediaData and the existing bubble is still a text placeholder.
      // This handles the notify→real-media upgrade when dead drop delivers.
      if (msg.id) {
        const existing = container.querySelector(`[data-msg-id="${msg.id}"]`);
        if (existing) {
          // If the new message has media and the existing bubble has no <img>/<audio>, upgrade it
          if (msg.mediaData && !existing.querySelector('img, audio')) {
            let upgBody = '';
            const _upgSrc = (msg.mediaData && !msg.mediaData.startsWith('blob:')) ? msg.mediaData : null;
            if (msg.mediaType === 'image' && _upgSrc) {
              upgBody = `<img src="${_upgSrc}" class="ob-media-img" loading="lazy" alt="Photo" onclick="this.requestFullscreen?.()">`;
            } else if (msg.mediaType === 'audio' && _upgSrc) {
              upgBody = `<audio controls src="${_upgSrc}" class="ob-media-audio" preload="metadata"></audio>`;
            }
            if (upgBody) {
              const bubble = existing.querySelector('.ob-bubble');
              if (bubble) {
                const bfoot = bubble.querySelector('.ob-bfoot');
                bubble.innerHTML = upgBody + (bfoot ? bfoot.outerHTML : '');
                if (scroll) container.scrollTop = container.scrollHeight;
              }
            }
          }
          if (!msg.mediaData && (msg.mediaHash || msg.hash || msg.id) && !existing.querySelector('img, audio')) {
            _hydrateMediaIntoBubble(existing, msg).catch(() => {});
          }
          return; // already in DOM — either upgraded above or truly duplicate
        }
      }
      container.querySelector('.ob-empty, .ob-skeleton')?.remove();

      const mine = msg.from === _myPeerId || msg.direction === 'out';
      const status = mine ? `<span class="ob-status${msg.status === 'sending' ? ' sending' : ''}">${msg.read ? '✓✓' : '✓'}</span>` : '';

      let body = '';
      // Skip dead blob: URLs (session-only, invalid after refresh)
      const _mediaData = (msg.mediaData && msg.mediaData.startsWith('blob:')) ? null : msg.mediaData;
      if (msg.mediaType === 'image' && _mediaData) {
        body = `<img src="${_mediaData}" class="ob-media-img" loading="lazy" alt="Photo" onclick="this.requestFullscreen?.()">`;
      } else if (msg.mediaType === 'audio' && _mediaData) {
        body = `<audio controls src="${_mediaData}" class="ob-media-audio" preload="metadata"></audio>`;
      } else if ((msg.mediaType === 'image' || msg.mediaType === 'audio') && (msg.mediaHash || msg.hash || msg.id)) {
        body = `<span class="ob-btext">${msg.mediaType === 'image' ? '📷 Loading photo…' : '🎤 Loading voice…'}</span>`;
      } else {
        body = `<span class="ob-btext">${OBUtils.esc(msg.text || '')}</span>`;
      }

      const div = document.createElement('div');
      div.className = 'ob-bubble-wrap ' + (mine ? 'mine' : 'theirs');
      div.dataset.msgId = msg.id || '';
      div.innerHTML = `<div class="ob-bubble">${body}<div class="ob-bfoot">${OBUtils.relTime(msg.ts)}${status}</div></div>`;
      container.appendChild(div);
      if (!msg.mediaData && (msg.mediaHash || msg.hash || msg.id) && (msg.mediaType === 'image' || msg.mediaType === 'audio')) {
        _hydrateMediaIntoBubble(div, msg).catch(() => {});
      }
      if (scroll) container.scrollTop = container.scrollHeight;
    } catch(e) { console.warn('[ChatUI] _appendBubble error:', e.message); }
  }

  function _markRead(msgId) {
    try {
      const el = document.querySelector(`[data-msg-id="${msgId}"] .ob-status`);
      if (el) { el.textContent = '✓✓'; el.classList.remove('sending'); }
    } catch {}
  }

  async function _buildRelaySafeImagePreview(file, peerId, itemId) {
    if (!file || !_mesh) return null;
    const candidates = [
      { maxDim: 200, quality: 0.60, maxSizeKB: 12 },
      { maxDim: 160, quality: 0.55, maxSizeKB: 9 },
      { maxDim: 128, quality: 0.50, maxSizeKB: 7 },
      { maxDim: 96,  quality: 0.45, maxSizeKB: 5 },
    ];

    for (const opts of candidates) {
      try {
        const previewUrl = await OBUtils.compressImage(file, opts);
        if (!previewUrl) continue;
        const probeMsg = {
          id: 'preview_probe',
          from: _myPeerId,
          to: peerId,
          itemId: itemId || null,
          text: '[photo]',
          mediaType: 'image',
          mediaData: previewUrl,
          _hasFullRes: true,
        };
        const fitsRelay = typeof _mesh._canRelayChatViaNostr === 'function'
          ? _mesh._canRelayChatViaNostr(probeMsg)
          : JSON.stringify(probeMsg).length <= 22000;
        if (fitsRelay) return previewUrl;
      } catch {}
    }

    return null;
  }

  function _dataUrlToBlob(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const header = dataUrl.slice(0, comma);
    const b64 = dataUrl.slice(comma + 1);
    const mime = (header.match(/^data:([^;]+)/i) || [null, 'application/octet-stream'])[1];
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  async function _sha256HexFromBlob(blob) {
    if (!blob || !crypto?.subtle) return '';
    const ab = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', ab);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function _storeChatBlob(hash, blob, itemId) {
    if (!hash || !blob || !_db?.blobs) return;
    const existing = await _db.blobs.where('hash').equals(hash).first().catch(() => null);
    const rec = {
      hash,
      blob,
      itemId: itemId || null,
      timestamp: Date.now(),
      size: blob.size,
      mime: blob.type || 'application/octet-stream',
    };
    if (!existing) {
      await _db.blobs.put(rec).catch(() => {});
      return;
    }
    if ((existing.size || 0) < blob.size) {
      await _db.blobs.put({ ...existing, ...rec, updatedAt: Date.now() }).catch(() => {});
    }
  }

  async function _hydrateMediaIntoBubble(wrapperEl, msg) {
    if (!wrapperEl || !_db?.blobs) return;
    const mediaKeys = [...new Set([msg?.mediaHash, msg?.hash, msg?.id].filter(Boolean))];
    if (!mediaKeys.length) return;
    let rec = null;
    for (const key of mediaKeys) {
      rec = await _db.blobs.where('hash').equals(key).first().catch(() => null);
      if (rec?.blob) break;
    }
    if (!rec?.blob) {
      _mesh?._requestBlobFromPeers?.(mediaKeys[0], msg.itemId || msg.id || null);
      return;
    }
    const src = URL.createObjectURL(rec.blob);
    const bubble = wrapperEl.querySelector('.ob-bubble');
    const bfoot = bubble?.querySelector('.ob-bfoot');
    if (!bubble) return;
    let body = '';
    if (msg.mediaType === 'image') {
      body = `<img src="${src}" class="ob-media-img" loading="lazy" alt="Photo" onclick="this.requestFullscreen?.()">`;
    } else if (msg.mediaType === 'audio') {
      body = `<audio controls src="${src}" class="ob-media-audio" preload="metadata"></audio>`;
    }
    if (!body) return;
    bubble.innerHTML = body + (bfoot ? bfoot.outerHTML : '');
  }

  async function _sendMediaViaPS2({ mediaType, dataUrl, text = '', itemId = null } = {}) {
    if (!_ps2?.im?.sendMedia || !_mesh?.sendChatMedia || !_currentChat?.peerId) return false;
    const routePeerId = _mesh.resolvePeerTarget?.(_currentChat.peerId) || _currentChat.peerId;
    const dcOpen = _mesh.dataChannels?.has(routePeerId) &&
                   _mesh.dataChannels.get(routePeerId)?.readyState === 'open';
    if (!dcOpen) return false;

    const blob = _dataUrlToBlob(dataUrl);
    if (!blob || blob.size === 0) return false;

    const msgId = (mediaType === 'audio' ? 'aud_' : 'img_') + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const mediaHash = await _sha256HexFromBlob(blob);
    if (mediaHash) {
      await _storeChatBlob(mediaHash, blob, itemId || ('chat:' + msgId));
    }

    const opt = _optimistic({
      id: msgId,
      mediaType,
      mediaData: dataUrl,
      mediaHash: mediaHash || null,
      text,
      status: 'sending',
    });
    _appendBubble(opt);

    const [ps2Result, meshResult] = await Promise.allSettled([
      _ps2.im.sendMedia(_currentChat.peerId, {
        id: msgId,
        mediaType,
        hash: mediaHash || null,
        bytes: blob.size,
        mimeType: blob.type || 'application/octet-stream',
        text,
        itemId: itemId || null,
      }),
      _mesh.sendChatMedia(_currentChat.peerId, blob, {
        id: msgId,
        from: _myPeerId,
        to: _currentChat.peerId,
        ts: Date.now(),
        itemId: itemId || null,
        mediaType,
        text,
        mediaHash: mediaHash || null,
        hash: mediaHash || null,
      }),
    ]);

    const ps2Ok = ps2Result.status === 'fulfilled';
    const meshOk = meshResult.status === 'fulfilled' && !!meshResult.value;
    if (meshOk) {
      _updateStatus(msgId, '✓');
      if (!ps2Ok && ps2Result.status === 'rejected') {
        console.warn('[ChatUI][PS2 media] metadata send failed, binary path succeeded:', ps2Result.reason?.message || ps2Result.reason);
      }
      return true;
    }

    const meshErr = meshResult.status === 'rejected' ? meshResult.reason : null;
    if (meshErr) {
      console.warn('[ChatUI][PS2 media] binary send failed, queueing dead-drop fallback:', meshErr?.message || meshErr);
    } else {
      console.warn('[ChatUI][PS2 media] binary send returned null, queueing dead-drop fallback');
    }

    const pendingLabel = mediaType === 'audio'
      ? '🎤 Voice message (will deliver when connected)'
      : '📷 Photo (will deliver when connected)';
    _mesh._storeDeadDrop?.(_currentChat.peerId, {
      id: msgId,
      from: _myPeerId,
      to: _currentChat.peerId,
      ts: Date.now(),
      itemId: itemId || null,
      text,
      mediaType,
      mediaData: dataUrl,
      mediaHash: mediaHash || null,
      _pendingMedia: true,
    }).catch(() => {});
    _mesh.sendChat(_currentChat.peerId, pendingLabel, itemId || null, {
      id: `${msgId}_notify`,
      mediaType,
      mediaData: undefined,
      _pendingMedia: true,
    }).catch(() => {});

    _updateStatus(msgId, '⏳');
    return true;
  }

  // ── Send text ───────────────────────────────────────────────────────────────
  async function _sendText() {
    let optimisticId = null;
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
      optimisticId = opt.id;
      _appendBubble(opt);

      const fallbackViaMesh = async () => {
        const fallbackMsg = {
          id: opt.id,
          from: _myPeerId,
          to: _currentChat.peerId,
          text,
          itemId: _currentChat.itemId || null,
          ts: Date.now(),
          read: false,
        };
        await _mesh.sendChat(
          _currentChat.peerId,
          text,
          _currentChat.itemId || null,
          null,
          fallbackMsg,
        );
      };

      const routePeerId = _mesh.resolvePeerTarget?.(_currentChat.peerId) || _currentChat.peerId;
      const dcOpen = _mesh.dataChannels?.has(routePeerId) &&
                     _mesh.dataChannels.get(routePeerId)?.readyState === 'open';
      if (!_ps2?.im?.sendText || !dcOpen) {
        await fallbackViaMesh();
        _updateStatus(opt.id, '✓');
        return;
      }

      const ps2Send = _ps2.im.sendText(
        _currentChat.peerId,
        text,
        { itemId: _currentChat.itemId || null, id: opt.id },
      );
      ps2Send.catch(() => {}); // avoid unhandled late rejection when timeout fallback wins

      const raceResult = await Promise.race([
        ps2Send.then(() => ({ ok: true })),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 2200)),
      ]);

      if (raceResult?.ok) {
        _updateStatus(opt.id, '✓');
        return;
      }

      if (raceResult?.timeout) {
        console.warn('[ChatUI][PS2] text send timeout, falling back to mesh');
      }
      await fallbackViaMesh();
      _updateStatus(opt.id, '✓');
    } catch(e) {
      console.error('[ChatUI] _sendText error:', e.message);
      if (optimisticId) _updateStatus(optimisticId, '⏳');
    } finally {
      const sendBtn = $('ob-send-btn');
      const input = $('ob-input');
      if (sendBtn) sendBtn.disabled = false;
      input?.focus?.();
    }
  }

  // ── Send image ──────────────────────────────────────────────────────────────
  async function _sendImage(file) {
    try {
      if (!file || !_currentChat || !_mesh) return;
      const allowed = ['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif'];
      if (!file.type.startsWith('image/') && !allowed.includes(file.type)) { OBUtils.notify('Only images can be sent', 'warning'); return; }
      if (file.size > 8 * 1024 * 1024) { OBUtils.notify('Image too large (max 8MB)', 'error'); return; }

      OBUtils.haptic('light');

      // Two-tier delivery:
      // 1. Preview (≤22KB base64 ≈ 16KB binary) → always goes via Nostr relay, receiver sees it immediately
      // 2. Full-res (≤280KB) → sent via DataChannel BLOB_STREAM when DC is open, upgrades the bubble
      const routePeerId = _mesh.resolvePeerTarget?.(_currentChat.peerId) || _currentChat.peerId;
      const dcOpen = _mesh.dataChannels?.has(routePeerId) &&
                     _mesh.dataChannels.get(routePeerId)?.readyState === 'open';

      const fullDataUrl = await OBUtils.compressImage(file, { maxDim: 900, quality: 0.78, maxSizeKB: 280 });

      const sentViaPS2 = await _sendMediaViaPS2({
        mediaType: 'image',
        dataUrl: fullDataUrl,
        text: '[photo]',
        itemId: _currentChat.itemId || null,
      });
      if (sentViaPS2) return;

      if (dcOpen) {
        // DC is open — send full-res directly, no preview needed
        const opt = _optimistic({ mediaType: 'image', mediaData: fullDataUrl, text: '[photo]', status: 'sending' });
        _appendBubble(opt);
        _mesh.sendChat(_currentChat.peerId, '[photo]', _currentChat.itemId || null, { mediaType: 'image', mediaData: fullDataUrl })
          .then(() => _updateStatus(opt.id, '✓'))
          .catch(e => { console.warn('[ChatUI]', e.message); _updateStatus(opt.id, '✓'); });
      } else {
        // DC not open — send Nostr-sized preview so receiver sees image immediately
        const previewUrl = await _buildRelaySafeImagePreview(file, _currentChat.peerId, _currentChat.itemId || null);
        const msgId = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

        // Show full-res in sender's own bubble
        const opt = _optimistic({ id: msgId, mediaType: 'image', mediaData: fullDataUrl, text: '[photo]', status: 'sending' });
        _appendBubble(opt);

        if (previewUrl) {
          // Send preview via Nostr (guaranteed to fit relay envelope)
          _mesh.sendChat(_currentChat.peerId, '[photo]', _currentChat.itemId || null,
            { id: msgId, mediaType: 'image', mediaData: previewUrl, _hasFullRes: true })
            .then(() => _updateStatus(msgId, '✓'))
            .catch(e => { console.warn('[ChatUI]', e.message); _updateStatus(msgId, '✓'); });
        } else {
          // Could not make a relay-safe preview — fall back to placeholder + queued full-res
          _mesh.sendChat(_currentChat.peerId, '📷 Photo (will sharpen when direct connection opens)',
            _currentChat.itemId || null, { id: msgId + '_notify', mediaType: 'image', mediaData: undefined, _pendingMedia: true })
            .catch(() => {});
          _updateStatus(msgId, '⏳');
        }

        // Also queue full-res for DC delivery — will upgrade receiver's bubble when DC opens
        _mesh._storeDeadDrop?.(_currentChat.peerId, {
          id: msgId + '_full', from: _myPeerId, to: _currentChat.peerId,
          ts: Date.now(), mediaType: 'image', mediaData: fullDataUrl,
          text: '[photo-fullres]', itemId: _currentChat.itemId || null,
          _upgradesId: msgId,  // tells receiver which bubble to upgrade
        }).catch(() => {});
      }
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

  async function _sendVoice(dataUrl) {
    if (!_currentChat || !_mesh) return;
    OBUtils.haptic('success');
    const sentViaPS2 = await _sendMediaViaPS2({
      mediaType: 'audio',
      dataUrl,
      text: '[voice]',
      itemId: _currentChat.itemId || null,
    });
    if (sentViaPS2) return;

    const routePeerId = _mesh.resolvePeerTarget?.(_currentChat.peerId) || _currentChat.peerId;
    const dcOpen = _mesh.dataChannels?.has(routePeerId) &&
                   _mesh.dataChannels.get(routePeerId)?.readyState === 'open';
    const opt = _optimistic({ mediaType: 'audio', mediaData: dataUrl, text: '[voice]', status: 'sending' });
    _appendBubble(opt);
    if (!dcOpen) {
      // No DC — voice can't go via Nostr (too large). Queue in Dead Drop for DC delivery.
      OBUtils.notify('Voice queued — will deliver when direct connection opens', 'info');
      _mesh._storeDeadDrop?.(_currentChat.peerId, {
        id: opt.id, from: _myPeerId, to: _currentChat.peerId,
        ts: opt.ts, mediaType: 'audio', mediaData: dataUrl,
        text: '[voice]', itemId: _currentChat.itemId || null,
      }).then(() => _updateStatus(opt.id, '⏳')).catch(() => _updateStatus(opt.id, '⏳'));
      // Send a tiny Nostr notification so receiver knows voice is coming
      _mesh.sendChat(_currentChat.peerId, '🎤 Voice message (will deliver when connected)',
        _currentChat.itemId || null, { id: opt.id + '_notify', mediaType: 'audio',
          mediaData: undefined, _pendingMedia: true }).catch(() => {});
      return;
    }
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
    // ob-close1 and ob-close2 removed — modal closed via back gesture or back button

    const imgIn = $('ob-img-input'), camIn = $('ob-cam-input');
    // Use a simple guard flag to prevent double-fire on browsers that emit both
    // 'change' and 'input' for the same file selection / camera capture.
    const _makeFileHandler = () => {
      let _busy = false;
      return e => {
        const file = e.target.files && e.target.files[0];
        if (!file || _busy) return;
        _busy = true;
        _sendImage(file).finally(() => { _busy = false; });
        e.target.value = '';
      };
    };
    if (imgIn) {
      const h = _makeFileHandler();
      imgIn.addEventListener('change', h);
      imgIn.addEventListener('input',  h);
    }
    if (camIn) {
      // Android WebView sometimes fires 'input' instead of 'change' after camera capture
      const h = _makeFileHandler();
      camIn.addEventListener('change', h);
      camIn.addEventListener('input',  h);
    }
    _safe('ob-btn-img', el => el.onclick = () => imgIn && imgIn.click());
    _safe('ob-btn-cam', el => el.onclick = () => camIn && camIn.click());
    _safe('ob-voice-btn', el => el.onclick = _toggleRecording);
    _safe('ob-btn-emoji', el => el.onclick = _toggleEmoji);

    const picker = $('ob-emoji-panel');
    if (picker) picker.querySelectorAll('.ob-em').forEach(btn => btn.onclick = () => _insertEmoji(btn.dataset.e));

    _safe('ob-btn-vcall', el => el.onclick = () => _call('video'));
    _safe('ob-btn-acall', el => el.onclick = () => _call('audio'));

    // Close on backdrop tap
    _safe('ob-chat-modal', el => el.onclick = e => { if (e.target.id === 'ob-chat-modal') _close(); });

    // Swipe-down to close (on drag handle or modal header)
    _safe('ob-drag-handle', handle => {
      let _sy = 0;
      handle.addEventListener('touchstart', e => { _sy = e.touches[0].clientY; }, { passive: true });
      handle.addEventListener('touchend', e => {
        if (e.changedTouches[0].clientY - _sy > 40) _close();
      }, { passive: true });
    });

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
      <!-- drag handle -->
      <div id="ob-drag-handle" style="display:flex;justify-content:center;padding:9px 0 2px;flex-shrink:0;cursor:pointer" aria-label="Swipe to close">
        <div style="width:40px;height:4px;border-radius:2px;background:var(--border,rgba(255,255,255,.15))"></div>
      </div>

      <!-- ════ INBOX VIEW ════ -->
      <div id="ob-view-inbox" style="display:flex;flex-direction:column;height:100%;overflow:hidden">
        <header class="ob-hdr">
          <div style="flex:1">
            <div class="ob-hdr-title">Messages</div>
            <div style="font-size:11px;color:var(--text-muted,#888);margin-top:2px">Swipe down or tap Browse to close</div>
          </div>
        </header>
        <!-- tab pills -->
        <div class="ob-tab-pills">
          <button class="ob-pill active" data-tab="shopping" onclick="_obSwitchInboxTab('shopping')">
            🛍 Shopping
            <span class="ob-pill-badge" id="ob-pill-shop-badge" style="display:none">0</span>
          </button>
          <button class="ob-pill" data-tab="people" onclick="_obSwitchInboxTab('people')">
            💬 People
            <span class="ob-pill-badge" id="ob-pill-ppl-badge" style="display:none">0</span>
          </button>
        </div>
        <div id="ob-inbox" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch">
          <div id="ob-inbox-shopping"></div>
          <div id="ob-inbox-people" style="display:none"></div>
        </div>
      </div>

      <!-- ════ THREAD VIEW ════ -->
      <div id="ob-view-thread" style="display:none;flex-direction:column;height:100%;overflow:hidden">
        <!-- thread header -->
        <header class="ob-hdr">
          <button id="ob-back-btn" class="ob-icon-btn" aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div id="ob-th-avatar" class="ob-avatar" style="width:38px;height:38px;font-size:14px;flex-shrink:0">?</div>
          <div style="flex:1;min-width:0">
            <div id="ob-th-name" style="font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.1px"></div>
            <div id="ob-th-status" class="ob-sub"></div>
          </div>
          <button id="ob-btn-acall" class="ob-icon-btn" aria-label="Voice call" title="Voice call" style="font-size:19px">📞</button>
          <button id="ob-btn-vcall" class="ob-icon-btn" aria-label="Video call" title="Video call" style="font-size:19px">📹</button>
        </header>

        <!-- item context banner -->
        <div id="ob-item-banner" style="display:none;align-items:center;gap:10px;padding:10px 14px;background:var(--bg-card,#1a1a2e);border-bottom:1px solid var(--border,rgba(255,255,255,.07));cursor:pointer;flex-shrink:0" onclick="window._obViewBannerItem && window._obViewBannerItem()"></div>

        <!-- messages -->
        <div id="ob-messages" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 14px 8px;display:flex;flex-direction:column;gap:3px"></div>

        <!-- recording indicator -->
        <div id="ob-rec-bar" style="display:none;justify-content:center;align-items:center;gap:8px;padding:7px 14px;font-size:13px;background:rgba(226,75,74,.08);flex-shrink:0;color:var(--text,#f0f0f0)"></div>

        <!-- emoji panel -->
        <div id="ob-emoji-panel" style="display:none;grid-template-columns:repeat(8,1fr);gap:1px;padding:8px 12px;background:var(--bg-card,#1a1a2e);border-top:1px solid var(--border,rgba(255,255,255,.06));max-height:130px;overflow-y:auto;flex-shrink:0">${emojiHTML}</div>

        <!-- input area -->
        <div class="ob-input-area">
          <div class="ob-tool-row">
            <button id="ob-btn-emoji" class="ob-tool-btn" aria-label="Emoji">😊</button>
            <button id="ob-btn-img"   class="ob-tool-btn" aria-label="Photo">🖼</button>
            <button id="ob-btn-cam"   class="ob-tool-btn" aria-label="Camera">📷</button>
            <button id="ob-voice-btn" class="ob-tool-btn" aria-label="Voice message">🎤</button>
          </div>
          <div class="ob-text-row">
            <textarea id="ob-input" rows="1" placeholder="Message…" aria-label="Message" maxlength="4000"></textarea>
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
    if ($('ob-chat-css')) return;
    const s = document.createElement('style');
    s.id = 'ob-chat-css';
    s.textContent = `
      /* ═══ Chat Modal Shell ═══ */
      #ob-chat-fab{display:none!important}
      #ob-chat-modal{
        position:fixed;top:0;bottom:calc(60px + env(safe-area-inset-bottom,0px));
        left:50%;width:min(100vw,480px);
        transform:translateX(-50%) translateY(102%);
        transition:transform .3s cubic-bezier(.4,0,.2,1);
        background:var(--bg-main,#0f0f18);
        color:var(--text,#f0f0f0);
        display:flex;flex-direction:column;z-index:899;
        box-shadow:0 -4px 40px rgba(0,0,0,.35);overflow:hidden;
        padding-top:env(safe-area-inset-top,0px)
      }
      #ob-chat-modal.open{transform:translateX(-50%) translateY(0)}

      /* ═══ Drag handle ═══ */
      #ob-drag-handle>div{background:var(--border,rgba(255,255,255,.15))!important}

      /* ═══ Header ═══ */
      .ob-hdr{
        display:flex;align-items:center;gap:10px;padding:13px 16px;
        flex-shrink:0;background:var(--bg-card,#141420);
        border-bottom:1px solid var(--border,rgba(255,255,255,.07));min-height:58px
      }
      .ob-hdr-title{font-size:19px;font-weight:800;flex:1;letter-spacing:-.3px}
      .ob-icon-btn{
        background:none;border:none;cursor:pointer;color:var(--text,#f0f0f0);
        padding:8px;border-radius:50%;font-size:18px;line-height:1;flex-shrink:0;
        transition:background .12s;-webkit-tap-highlight-color:transparent;
        width:38px;height:38px;display:flex;align-items:center;justify-content:center
      }
      .ob-icon-btn:active{background:rgba(255,255,255,.08)}
      .ob-sub{font-size:11px;color:var(--text-muted,#888);margin-top:1px;display:flex;align-items:center;gap:3px}
      .ob-dot-online{width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block}
      .ob-avatar{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;color:#fff;flex-shrink:0;letter-spacing:-.5px}

      /* ═══ Inbox: tab pills ═══ */
      .ob-tab-pills{
        display:flex;gap:8px;padding:12px 16px;
        background:var(--bg-card,#141420);
        border-bottom:1px solid var(--border,rgba(255,255,255,.07));flex-shrink:0
      }
      .ob-pill{
        flex:1;padding:9px 12px;border-radius:24px;
        border:1.5px solid var(--border,rgba(255,255,255,.1));
        background:none;color:var(--text-muted,#888);font-size:13px;font-weight:700;
        cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;
        transition:all .15s;-webkit-tap-highlight-color:transparent
      }
      .ob-pill.active{background:var(--primary,#6366f1);border-color:var(--primary,#6366f1);color:#fff}
      .ob-pill-badge{background:#E24B4A;color:#fff;font-size:10px;font-weight:700;min-width:16px;height:16px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;padding:0 3px}

      /* ═══ Inbox: shopping rows ═══ */
      .ob-shop-row{
        display:flex;gap:0;padding:14px 16px;cursor:pointer;
        border-bottom:1px solid var(--border,rgba(255,255,255,.05));
        transition:background .1s;-webkit-tap-highlight-color:transparent
      }
      .ob-shop-row:active{background:rgba(255,255,255,.04)}
      .ob-shop-thumb-wrap{position:relative;flex-shrink:0;width:68px;height:68px;border-radius:12px;overflow:visible;margin-right:13px}
      .ob-shop-thumb{width:68px;height:68px;border-radius:12px;object-fit:cover;display:block;background:rgba(255,255,255,.06)}
      .ob-shop-thumb.loaded{opacity:1}
      .ob-shop-thumb-placeholder{width:68px;height:68px;border-radius:12px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0}
      .ob-shop-online-dot{position:absolute;bottom:-2px;right:-2px;width:11px;height:11px;border-radius:50%;background:#22c55e;border:2px solid var(--bg-card,#141420)}
      .ob-shop-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
      .ob-shop-item-title{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text,#f0f0f0)}
      .ob-shop-item-meta{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:2px}
      .ob-shop-price{font-weight:700}.ob-shop-price.free{color:#22c55e}.ob-shop-price.swap{color:#f59e0b}
      .ob-shop-status{font-size:11px}.ob-shop-status.avail{color:#22c55e}.ob-shop-status.pend{color:#f59e0b}.ob-shop-status.gone{color:#888}
      .ob-shop-divider{height:1px;background:var(--border,rgba(255,255,255,.06));margin:5px 0}
      .ob-shop-peer-row{display:flex;align-items:center;gap:7px}
      .ob-mini-avatar{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0}
      .ob-shop-peer-info{display:flex;align-items:center;gap:5px;flex-shrink:0}
      .ob-shop-role{font-size:11px;font-weight:600;color:var(--text-muted,#888)}
      .ob-shop-preview{flex:1;font-size:12px;color:var(--text-muted,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      .ob-shop-time{font-size:11px;color:var(--text-muted,#888);flex-shrink:0}

      /* ═══ Inbox: people rows ═══ */
      .ob-inbox-row{
        display:flex;align-items:center;gap:13px;padding:14px 16px;
        cursor:pointer;border-bottom:1px solid var(--border,rgba(255,255,255,.04));
        transition:background .1s;-webkit-tap-highlight-color:transparent
      }
      .ob-inbox-row:active{background:rgba(255,255,255,.05)}
      .ob-row-online .ob-inbox-preview{color:#22c55e!important}
      .ob-inbox-info{flex:1;min-width:0}
      .ob-inbox-name{font-size:15px;font-weight:700;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ob-inbox-preview{font-size:13px;color:var(--text-muted,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
      .ob-inbox-meta{font-size:11px;color:var(--text-muted,#888);flex-shrink:0}
      .ob-private-tag{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:rgba(99,102,241,.2);color:#a5b4fc;padding:1px 6px;border-radius:4px}
      .ob-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#E24B4A;color:#fff;font-size:10px;font-weight:700}

      /* ═══ Empty state ═══ */
      .ob-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:52px 24px;gap:10px;text-align:center;flex:1}
      .ob-empty-title{font-size:18px;font-weight:700;letter-spacing:-.2px}
      .ob-empty-sub{font-size:13px;color:var(--text-muted,#888);line-height:1.6}

      /* ═══ Skeleton loaders ═══ */
      .ob-skel-row{display:flex;gap:12px;padding:14px 16px;align-items:center}
      .ob-skel-av{width:42px;height:42px;border-radius:50%;background:rgba(255,255,255,.07);animation:ob-pulse 1.4s ease-in-out infinite;flex-shrink:0}
      .ob-skel-line{height:12px;border-radius:6px;background:rgba(255,255,255,.07);animation:ob-pulse 1.4s ease-in-out infinite}
      .ob-skel-bubble{margin:4px 14px}.ob-skel-mine{display:flex;justify-content:flex-end}
      .ob-skel-mine .ob-skel-line{background:rgba(99,102,241,.2)}
      @keyframes ob-pulse{0%,100%{opacity:.45}50%{opacity:1}}

      /* ═══ Chat thread ═══ */
      .ob-day-sep{text-align:center;font-size:11px;color:var(--text-muted,#888);margin:12px 0;letter-spacing:.3px}

      /* bubble wrap */
      .ob-bubble-wrap{display:flex;flex-direction:column;max-width:80%}
      .ob-bubble-wrap.mine{align-self:flex-end}
      .ob-bubble-wrap.theirs{align-self:flex-start}

      /* bubbles */
      .ob-bubble{
        padding:10px 14px;border-radius:20px;
        font-size:15px;line-height:1.5;word-break:break-word
      }
      .ob-bubble-wrap.theirs .ob-bubble{
        background:var(--bg-card,#1e1e2e);
        border:1px solid var(--border,rgba(255,255,255,.06));
        border-bottom-left-radius:4px
      }
      .ob-bubble-wrap.mine .ob-bubble{
        background:var(--primary,#6366f1);color:#fff;
        border-bottom-right-radius:4px;
        box-shadow:0 2px 8px rgba(99,102,241,.25)
      }
      .ob-bfoot{display:flex;align-items:center;justify-content:flex-end;gap:3px;font-size:10px;margin-top:4px;opacity:.55}
      .ob-bubble-wrap.theirs .ob-bfoot{justify-content:flex-start}
      .ob-status{font-size:11px}.ob-status.sending{opacity:.4}
      .ob-media-img{width:100%;max-width:240px;border-radius:14px;display:block;cursor:zoom-in}
      .ob-media-audio{width:210px;height:36px}

      /* ═══ Input area ═══ */
      .ob-input-area{
        flex-shrink:0;
        background:var(--bg-card,#141420);
        border-top:1px solid var(--border,rgba(255,255,255,.07))
      }
      .ob-tool-row{display:flex;gap:6px;padding:10px 14px 4px}
      .ob-tool-btn{
        width:38px;height:38px;border-radius:50%;border:none;
        background:rgba(255,255,255,.07);font-size:18px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        transition:background .12s;flex-shrink:0;-webkit-tap-highlight-color:transparent
      }
      .ob-tool-btn:active{background:rgba(255,255,255,.14)}
      .ob-text-row{display:flex;align-items:flex-end;gap:9px;padding:4px 14px 14px}
      #ob-input{
        flex:1;padding:11px 16px;
        border:1.5px solid var(--border,rgba(255,255,255,.1));
        border-radius:24px;font-size:15px;font-family:inherit;
        resize:none;outline:none;max-height:132px;overflow-y:auto;
        line-height:1.45;background:var(--bg-main,#0f0f18);
        color:var(--text,#f0f0f0);transition:border-color .15s
      }
      #ob-input:focus{border-color:var(--primary,#6366f1)}
      #ob-input::placeholder{color:var(--text-muted,#888)}
      .ob-send-btn{
        width:44px;height:44px;border-radius:50%;border:none;
        background:var(--primary,#6366f1);color:#fff;
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;flex-shrink:0;transition:transform .12s;
        box-shadow:0 3px 12px rgba(99,102,241,.4);-webkit-tap-highlight-color:transparent
      }
      .ob-send-btn:active{transform:scale(.88)}
      .ob-send-btn:disabled{opacity:.35;cursor:not-allowed}
      .ob-em{background:none;border:none;font-size:22px;cursor:pointer;padding:5px;border-radius:8px;transition:background .1s;-webkit-tap-highlight-color:transparent}
      .ob-em:active{background:rgba(255,255,255,.08)}

      /* ═══ Notifications / Toast ═══ */
      .ob-toast-notif{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:var(--bg-card,#1e1e2e);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:16px;padding:12px 16px;display:flex;align-items:center;gap:10px;max-width:320px;width:90%;font-size:14px;color:var(--text,#f0f0f0);box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:2100;cursor:pointer;animation:ob-toast-in .22s cubic-bezier(.4,0,.2,1)}
      .ob-toast-av{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;flex-shrink:0}
      @keyframes ob-toast-in{from{opacity:0;transform:translateX(-50%) translateY(-12px) scale(.95)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
      @keyframes ob-toast-out{from{opacity:1}to{opacity:0;transform:translateX(-50%) translateY(-8px)}}

      /* ═══ Item banner inside thread ═══ */
      .ob-banner-thumb{width:48px;height:48px;object-fit:cover;border-radius:10px;flex-shrink:0}
      .ob-banner-no-img{width:48px;height:48px;border-radius:10px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:22px}
      .ob-banner-img-wrap{flex-shrink:0}
      .ob-banner-info{flex:1;min-width:0}
      .ob-banner-title{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text,#f0f0f0)}
      .ob-banner-meta{font-size:13px;font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ob-banner-view{background:none;border:none;color:var(--text-muted,#888);font-size:22px;cursor:pointer;padding:4px;border-radius:8px;flex-shrink:0;line-height:1}
      .ob-list-hdr{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted,#888);padding:10px 16px 4px}
    `;
    document.head.appendChild(s);
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

    return { init, openWithSeller, openInbox };
})();

if (typeof window !== 'undefined') window.ChatUI = window.ChatUI || ChatUI;
