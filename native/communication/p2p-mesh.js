/**
 * OurBackyardMesh — 完全去中心化的 P2P 网格
 *
 * 负责：
 *   1. 节点发现（LAN BroadcastChannel + Nostr DHT）
 *   2. WebRTC 连接管理（含 ICE restart 自动重连）
 *   3. GossipSub 物品广播（替换 server.py 的 NEW_ITEM 转发）
 *   4. E2E 加密 1对1 聊天
 *   5. Dead Drop 离线消息存储/投递
 *
 * 使用方式：
 *   const mesh = new OurBackyardMesh({ peerId, h3Cell, db });
 *   await mesh.init();
 *   mesh.on('item', item => loadItems());
 *   mesh.on('chat', msg => renderChatMsg(msg));
 *   mesh.broadcastItem(item);
 *   mesh.sendChat(toPeerId, text);
 */

class OurBackyardMesh extends EventTarget {
  static ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // TURN — 未来替换为桌面全节点提供的社区 TURN
    { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  static CHUNK_SIZE    = 65536;  // 64KB DataChannel 分片 (raised for speed)
  static MAX_BUFFER    = 4194304; // 4MB 背压阈值
  static HEARTBEAT_MS  = 15000;
  static MAX_PEERS     = 12;      // 每节点最多维持连接数
  static BLOB_BATCH    = 30;      // 每次同步最多请求的图片数

  constructor({ peerId, h3Cell, db, onItem, onChat, onPeers, onStatus }) {
    super();
    this.peerId   = peerId;
    this.h3Cell   = h3Cell;
    this.db       = db;           // Dexie 实例（用于 Dead Drop）
    this.onItem   = onItem;       // (item) => void
    this.onChat   = onChat;       // (msg) => void
    this.onPeers  = onPeers;      // (count) => void
    this.onStatus = onStatus;     // (mode) => 'nostr'|'lan'|'offline'

    // WebRTC 状态
    this.peerConns    = new Map();  // peerId -> RTCPeerConnection
    this.dataChannels = new Map();  // peerId -> RTCDataChannel
    this.chatKeys     = new Map();  // peerId -> CryptoKey（ECDH 派生）
    this._pendingChat  = new Map();  // peerId -> [{fromPeerId, envelope}] waiting for key
    this.peerMeta     = new Map();  // peerId -> { h3, ts, ... }

    // 图片传输状态
    this.incomingImg  = new Map();  // itemId -> { chunks, total, received }

    // 信令层（Nostr）
    this.signaling    = null;

    // LAN 发现（同设备/同浏览器测试用 BroadcastChannel）
    this.lanChannel   = null;

    // 心跳
    this._hbTimer     = null;

    // 本节点 ECDH 密钥对（用于聊天加密）
    this._myECDHKey   = null;
    this._myECDHPub   = null;
  }

  // ─────────────────────────── 初始化 ───────────────────────────

  async init() {
    // 生成 ECDH 密钥对
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    this._myECDHKey = pair.privateKey;
    this._myECDHPub = await crypto.subtle.exportKey('raw', pair.publicKey);

    // LAN 发现（BroadcastChannel 模拟 mDNS）
    this._initLAN();

    // Nostr 信令（互联网节点发现）
    this._initNostr().catch(e => console.warn('[Mesh] Nostr init failed:', e));

    // 心跳 + 定期重新广播
    this._hbTimer = setInterval(() => this._heartbeat(), OurBackyardMesh.HEARTBEAT_MS);

    // 检查 Dead Drop 待投递消息
    setTimeout(() => this._drainDeadDrop(), 3000);
    // 周期性重试 Dead Drop（每30s），确保新连接后及时投递
    setInterval(() => this._drainDeadDrop(), 30000);

    console.log('[Mesh] Initialized, peerId:', this.peerId);
    return this;
  }

  _initLAN() {
    try {
      // Use L7 channel so same-area users on different L9 cells can find each other
      const lanChannel = NostrSignaling._toL7 ? NostrSignaling._toL7(this.h3Cell) : this.h3Cell;
      this.lanChannel = new BroadcastChannel(`ourbackyard:${lanChannel}`);
      this.lanChannel.onmessage = (e) => this._handleLANMsg(e.data);

      // 广播自己上线
      this._lanAnnounce();
      this.onStatus?.('lan');
    } catch (e) {
      console.warn('[Mesh] BroadcastChannel not available:', e);
    }
  }

  async _initNostr() {
    this.signaling = new NostrSignaling({
      peerId:    this.peerId,
      h3Cell:    this.h3Cell,
      privateKey: null,
      onSignal:  (fromPeerId, signal) => this._handleSignal(fromPeerId, signal),
      onPeerAnnounce: (peerId, meta) => this._onPeerAnnounce(peerId, meta),
      onChat:    (fromPeerId, msg)  => this._handleChatMsg(fromPeerId, { payload: msg }),
    });
    await this.signaling.init();
    this.onStatus?.(this.signaling.isOnline ? 'nostr' : 'lan');

    // Re-announce with ecdhPub so peers can do ECDH key exchange immediately
    if (this._myECDHPub) {
      this.signaling.announce({ ecdhPub: this._ab2hex(this._myECDHPub) }).catch(() => {});
    }
  }

  // ─────────────────────────── 节点发现 ───────────────────────────

  _lanAnnounce() {
    this.lanChannel?.postMessage({
      type:   'ANNOUNCE',
      peerId: this.peerId,
      h3:     this.h3Cell,
      ts:     Date.now(),
      ecdhPub: this._ab2hex(this._myECDHPub),
    });
  }

  _handleLANMsg(data) {
    if (!data || data.peerId === this.peerId) return;

    switch (data.type) {
      case 'ANNOUNCE':
        this._onPeerAnnounce(data.peerId, data);
        break;
      case 'SIGNAL':
        if (data.target === this.peerId) {
          this._handleSignal(data.from, data.signal);
        }
        break;
    }
  }

  async _onPeerAnnounce(peerId, meta) {
    // Validate peerId format to prevent injection via crafted Nostr events
    if (!peerId || typeof peerId !== 'string' || peerId.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(peerId)) return;
    if (peerId === this.peerId) return;
    if (this.peerConns.has(peerId)) return;
    if (this.peerConns.size >= OurBackyardMesh.MAX_PEERS) return;

    this.peerMeta.set(peerId, { ...meta, lastSeen: Date.now() });

    // 保存对方 ECDH 公钥
    if (meta.ecdhPub) {
      try {
        const rawKey = this._hex2ab(meta.ecdhPub);
        const pubKey = await crypto.subtle.importKey(
          'raw', rawKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        await this._deriveSharedKey(peerId, pubKey);
      } catch {}
    }

    // 字典序小的一方发起 offer（避免双方同时发 offer）
    if (this.peerId < peerId) {
      await this._createOffer(peerId);
    }
    // 字典序大的一方等待 offer

    // ── Bridge: also notify the inline WebRTC system so it establishes
    // its own DataChannel for handleMessage() / MerkleSync / image transfer.
    // Use a small delay so the mesh connection completes first.
    if (typeof window !== 'undefined' && typeof window.connectToPeer === 'function') {
      setTimeout(() => window.connectToPeer(peerId), 1500);
    }
  }

  // ─────────────────────────── WebRTC 连接管理 ───────────────────────────

  async _createOffer(peerId) {
    if (this.peerConns.has(peerId)) return;

    const pc = this._newPC(peerId);

    // 创建双向数据通道
    const dc = pc.createDataChannel('mesh', { ordered: true });
    this._setupDataChannel(peerId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const offerSdp = { type: offer.type, sdp: offer.sdp };
    this._sendSignal(peerId, { type: 'offer', sdp: offerSdp, ecdhPub: this._ab2hex(this._myECDHPub) });
  }

  async _handleSignal(peerId, signal) {
    switch (signal.type) {
      case 'offer': {
        if (signal.ecdhPub) await this._storeECDHPub(peerId, signal.ecdhPub);

        let pc = this.peerConns.get(peerId);

        // Glare resolution: if we already sent an offer and our peerId is larger,
        // the other side should have backed off. But if we already have a stable
        // connection or are in the wrong state, just ignore duplicate offers.
        if (pc) {
          const state = pc.signalingState;
          // If already connected or negotiating as offerer, skip this duplicate
          if (state === 'stable') return; // already connected or just completed — ignore re-offer
          if (state === 'have-local-offer') {
            // Glare: both sent offers. Lower peerId wins (they become answerer).
            if (this.peerId > peerId) {
              // We lose — roll back and answer
              try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
            } else {
              return; // We win — ignore their offer, wait for their answer
            }
          }
          if (state !== 'stable') {
            // Unexpected state — close and recreate
            pc.close();
            this.peerConns.delete(peerId);
            pc = null;
          }
        }

        if (!pc) pc = this._newPC(peerId);
        pc.ondatachannel = (e) => this._setupDataChannel(peerId, e.channel);

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          const answerSdp = { type: answer.type, sdp: answer.sdp };
          this._sendSignal(peerId, { type: 'answer', sdp: answerSdp, ecdhPub: this._ab2hex(this._myECDHPub) });
        } catch (e) {
          console.warn('[Mesh] offer handling error:', e.message);
        }
        break;
      }
      case 'answer': {
        if (signal.ecdhPub) await this._storeECDHPub(peerId, signal.ecdhPub);
        const pc = this.peerConns.get(peerId);
        if (!pc) return;
        // Only apply answer in have-local-offer state
        if (pc.signalingState !== 'have-local-offer') {
          // Duplicate answer from multiple Nostr relays — silently ignore
          log && log('[Mesh] Duplicate answer ignored, state:', pc.signalingState);
          return;
        }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        } catch (e) {
          console.warn('[Mesh] answer handling error:', e.message);
        }
        break;
      }
      case 'ice-candidate': {
        const pc = this.peerConns.get(peerId);
        if (pc && signal.candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch {}
        }
        break;
      }
    }
  }

  _newPC(peerId) {
    const pc = new RTCPeerConnection({ iceServers: OurBackyardMesh.ICE_SERVERS });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        // Serialize RTCIceCandidate to plain object before passing to _sendSignal
        const candidate = e.candidate.toJSON ? e.candidate.toJSON() : {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
          usernameFragment: e.candidate.usernameFragment,
        };
        this._sendSignal(peerId, { type: 'ice-candidate', candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        console.log('[Mesh] Connected to peer:', peerId);
        this.onPeers?.(this.dataChannels.size + 1);
      } else if (state === 'failed' || state === 'disconnected') {
        this._cleanPeer(peerId);
        // 自动重连（如果对方还在列表里）
        setTimeout(() => {
          if (this.peerMeta.has(peerId) && !this.peerConns.has(peerId)) {
            if (this.peerId < peerId) this._createOffer(peerId);
          }
        }, 3000);
      }
    };

    // ICE Restart — 断线自动重连
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        console.log('[Mesh] ICE failed, restarting...', peerId);
        pc.restartIce();
      }
    };

    this.peerConns.set(peerId, pc);
    return pc;
  }

  _setupDataChannel(peerId, dc) {
    dc.binaryType = 'arraybuffer';

    dc.onopen  = () => {
      this.dataChannels.set(peerId, dc);
      this.onPeers?.(this.dataChannels.size);
      // Send our ECDH public key directly over DataChannel so the peer
      // can derive the shared key immediately — no need to wait for Nostr announce
      if (this._myECDHPub) {
        try {
          dc.send(JSON.stringify({
            type: 'ECDH_PUB',
            from: this.peerId,
            ecdhPub: this._ab2hex(this._myECDHPub),
          }));
        } catch {}
      }
      // 连接成功后发送本节点的最新物品列表摘要（增量同步触发）
      this._requestSync(peerId);
      // 投递 Dead Drop 中对方的离线消息
      this._deliverDeadDrop(peerId);

      // ── Bridge: register this DataChannel in the inline system's
      // global dataChannels{} so sendToPeer() / SYNC_REQUEST responses
      // can reach this peer even when the WS relay is down.
      if (typeof window !== 'undefined') {
        if (!window.dataChannels) window.dataChannels = {};
        window.dataChannels[peerId] = dc;
        console.log('[Mesh] Bridged DC into inline system for peer:', peerId);
      }
    };

    dc.onclose = () => {
      this.dataChannels.delete(peerId);
      this.onPeers?.(this.dataChannels.size);
      // Remove from inline bridge too
      if (typeof window !== 'undefined' && window.dataChannels) {
        delete window.dataChannels[peerId];
      }
    };

    dc.onmessage = (e) => {
      // Route to mesh handler first (handles ITEM, SYNC_REQ/RESP, CHAT etc)
      this._onData(peerId, e.data);

      // ── Bridge: route to inline handleMessage() for WEBRTC_SIGNAL, HEARTBEAT etc.
      // Skip message types that mesh already handles to prevent duplicate writes.
      if (typeof e.data === 'string' && typeof window.handleMessage === 'function') {
        try {
          const _m = JSON.parse(e.data);
          // CHANNEL_MSG deliberately NOT in this list — it must reach window.handleMessage
          // so _listenChannelMsgs (p1p2-features) can process it.
          const _meshHandled = ['ITEM','NEW_ITEM','SYNC_REQ','SYNC_RESP','SYNC_RESPONSE',
                                'BLOB_REQ','BLOB_RESP','BLOB_STREAM_START','BLOB_STREAM_END',
                                'CHAT','CHAT_READ','IMG_HEADER','IMG_END','PING','PONG'];
          if (!_meshHandled.includes(_m.type)) {
            window.handleMessage(e.data).catch?.(() => {});
          }
        } catch { window.handleMessage(e.data).catch?.(() => {}); }
      }
    };

    // 背压控制
    dc.bufferedAmountLowThreshold = 65536;
    this.dataChannels.set(peerId, dc);
  }

  _cleanPeer(peerId) {
    this.peerConns.get(peerId)?.close();
    this.peerConns.delete(peerId);
    this.dataChannels.delete(peerId);
    this.onPeers?.(this.dataChannels.size);
  }

  // ─────────────────────────── 数据接收路由 ───────────────────────────

  async _onData(fromPeerId, raw) {
    // 二进制 → 优先走 blob stream，否则走旧 imgTransfer
    if (raw instanceof ArrayBuffer) {
      if (!this._routeBinaryChunk(fromPeerId, raw)) {
        this._handleImgChunk(fromPeerId, raw);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'ITEM':         return this._handleItem(fromPeerId, msg.item);
      case 'ITEM_UPDATE':  return this._handleItemUpdate(msg);
      // Aliases for inline system message types (keeps both protocols working)
      case 'NEW_ITEM':     return this._handleItem(fromPeerId, msg.item);
      case 'SYNC_REQ':     return this._handleSyncReq(fromPeerId, msg);
      case 'SYNC_RESP':     return this._handleSyncResp(fromPeerId, msg);
      case 'SYNC_RESPONSE': return this._handleSyncResp(fromPeerId, msg);
      case 'CHAT':         return this._handleChatMsg(fromPeerId, msg);
      case 'CHAT_READ':    return this._handleChatRead(fromPeerId, msg);
      case 'IMG_HEADER':   return this._startImgTransfer(fromPeerId, msg);
      case 'IMG_END':      return this._finishImgTransfer(fromPeerId, msg);
      case 'PING':         return this._send(fromPeerId, { type: 'PONG', ts: msg.ts });
      case 'ECDH_PUB':     return this._storeECDHPub(fromPeerId, msg.ecdhPub);
      // Chat media announcement: stores meta so BLOB_STREAM_END can fire onChat
      case 'CHAT_MEDIA_META': return this._handleChatMediaMeta(fromPeerId, msg);
      // CHANNEL_MSG: route to window.handleMessage for p1p2-features _listenChannelMsgs
      case 'CHANNEL_MSG':
        // Validate CHANNEL_MSG structure before routing to prevent injection
        if (msg.channel && typeof msg.channel === 'string' && msg.channel.length <= 40 &&
            msg.text && typeof msg.text === 'string' && msg.text.length <= 2000) {
          if (typeof window !== 'undefined' && typeof window.handleMessage === 'function') {
            window.handleMessage(raw).catch?.(() => {});
          }
        }
        return;
      case 'BLOB_REQ':          return this._handleBlobReq(fromPeerId, msg);
      case 'BLOB_RESP':         return this._handleBlobResp(fromPeerId, msg);
      case 'BLOB_STREAM_START': return this._handleBlobStreamStart(fromPeerId, msg);
      case 'BLOB_STREAM_END':   return this._handleBlobStreamEnd(fromPeerId, msg);
      default: break;
    }
  }

  // ─────────────────────────── 物品广播（替换 server.py NEW_ITEM） ───────────────────────────

  /**
   * 向所有已连接邻居广播新物品
   * GossipSub 风格：每个收到的节点再转发给自己的邻居（TTL 递减）
   */
  broadcastItem(item, ttl = 4) {
    const msg = { type: 'ITEM', item, ttl };
    this._flood(msg);
  }

  broadcastItemUpdate(itemId, status) {
    this._flood({ type: 'ITEM_UPDATE', itemId, status, ts: Date.now(), from: this.peerId });
  }

  _handleItem(fromPeerId, item) {
    // Accept items with either id or itemId (DB uses ++id, not itemId)
    const localId = item?.id ?? item?.itemId;
    if (!item || (localId === undefined && !item.title)) return;

    // Normalize: strip the sender's local DB id to avoid PK conflicts on put
    // We store by content (sellerId + timestamp) rather than remote id
    const storeItem = { ...item, _receivedFrom: fromPeerId };
    delete storeItem.id; // remove remote PK, let local DB assign its own

    // Upsert by sellerId + timestamp (natural unique key for broadcast items)
    if (this.db) {
      this.db.items
        .where('timestamp').equals(item.timestamp || 0)
        .filter(i => i.sellerId === item.sellerId)
        .first()
        .then(existing => {
          if (!existing) {
            // Double-check by title+sellerId before insert (SyncController uses same check)
            return this.db.items
              .where('title').equals(item.title || '')
              .filter(i => i.sellerId === item.sellerId)
              .first()
              .then(byTitle => {
                if (!byTitle) {
                  this.db.items.add(storeItem).catch(() => {});
                }
              });
          }
        })
        .catch(() => {}); // On query error: skip (don't add blindly)
    }

    this.onItem?.(item);

    // Gossip 转发（TTL 递减）
    const ttl = (item._ttl ?? 4) - 1;
    if (ttl > 0) {
      const msg = { type: 'ITEM', item: { ...item, _ttl: ttl }, ttl };
      this._floodExcept(msg, fromPeerId);
    }
  }

  _handleItemUpdate(msg) {
    this.db?.items.where('itemId').equals(msg.itemId).modify({ status: msg.status });
    this.onItem?.(msg);  // 通知 UI 刷新
  }

  // ─────────────────────────── 增量同步（替换服务器历史物品推送） ───────────────────────────

  async _requestSync(peerId) {
    // 1. 发送 items 同步请求
    const items = await this.db?.items.orderBy('timestamp').reverse().limit(100).toArray() ?? [];
    const ids = items.map(i => (i.sellerId || '') + ':' + (i.timestamp || 0));
    this._send(peerId, { type: 'SYNC_REQ', ids, since: Date.now() - 7 * 86400000, peerId: this.peerId });

    // 2. 主动请求我们本地有 item 但缺少 blob 的图片（不等对方 SYNC_RESP 再触发）
    setTimeout(async () => {
      if (!this.db || !this.dataChannels.has(peerId)) return;
      try {
        const allItems = await this.db.items.orderBy('timestamp').reverse().limit(50).toArray();
        const hashSet = new Set();
        allItems.forEach(i => {
          (i.imageHashes?.length ? i.imageHashes : (i.imageHash ? [i.imageHash] : [])).forEach(h => hashSet.add(h));
        });
        if (!hashSet.size) return;
        const existing = await this.db.blobs.where('hash').anyOf([...hashSet]).toArray();
        const have = new Set(existing.map(b => b.hash));
        const need = [...hashSet].filter(h => !have.has(h));
        if (need.length > 0) {
          console.log(`[Mesh] Proactive BLOB_REQ: ${need.length} missing images from ${peerId}`);
          this._send(peerId, { type: 'BLOB_REQ', hashes: need.slice(0, OurBackyardMesh.BLOB_BATCH) });
        }
      } catch {}
    }, 500); // small delay to let SYNC_RESP arrive first
  }

  async _handleSyncReq(fromPeerId, msg) {
    const theirIds = new Set(msg.ids ?? []);
    // 找出对方没有的物品（用 sellerId:timestamp 做可移植去重键）
    const allItems = await this.db?.items
      .where('timestamp').above(msg.since ?? 0)
      .toArray() ?? [];
    const missing = allItems.filter(i => {
      const key = (i.sellerId || '') + ':' + (i.timestamp || 0);
      return !theirIds.has(key);
    });
    if (missing.length > 0) {
      // Strip local DB id before sending (receiver will assign its own)
      const toSend = missing.slice(0, 50).map(i => {
        const copy = { ...i };
        delete copy.id;
        return copy;
      });
      this._send(fromPeerId, { type: 'SYNC_RESP', items: toSend });
    }
  }

  _handleSyncResp(fromPeerId, msg) {
    if (!msg.items?.length) return;
    msg.items.forEach(item => this._handleItem(fromPeerId, item));

    // After receiving items, request blobs for any items that have images
    // but whose blobs we don't have locally yet.
    if (!this.db) return;
    // Collect all image hashes from received items (dedup)
    const hashSet = new Set();
    msg.items.forEach(i => {
      (i.imageHashes?.length ? i.imageHashes : (i.imageHash ? [i.imageHash] : [])).forEach(h => hashSet.add(h));
    });
    const hashes = [...hashSet].filter(Boolean);
    if (!hashes.length) return;

    // Check which hashes we are missing, then ask the sender to push those blobs
    this.db.blobs.where('hash').anyOf(hashes).toArray()
      .then(existing => {
        const have = new Set(existing.map(b => b.hash));
        const need = hashes.filter(h => !have.has(h));
        if (need.length > 0) {
          // Send in batches to avoid oversized messages
          const batch = need.slice(0, OurBackyardMesh.BLOB_BATCH);
          this._send(fromPeerId, { type: 'BLOB_REQ', hashes: batch });
          // Queue remainder for next sync cycle
          if (need.length > OurBackyardMesh.BLOB_BATCH) {
            setTimeout(() => {
              if (this.dataChannels.has(fromPeerId)) {
                this._send(fromPeerId, { type: 'BLOB_REQ', hashes: need.slice(OurBackyardMesh.BLOB_BATCH) });
              }
            }, 2000);
          }
        }
      }).catch(() => {
        // Fallback: request all
        this._send(fromPeerId, { type: 'BLOB_REQ', hashes });
      });
  }

  // ─────────────────────────── 聊天（E2E 加密） ───────────────────────────

  /**
   * 发送私信给指定节点（E2E AES-GCM 加密）
   * @param {string} toPeerId
   * @param {string} text
   * @param {string} [itemId]  绑定的商品 ID（交易协商）
   */
  async sendChat(toPeerId, text, itemId = null, media = null) {
    const msg = {
      id:       this._uuid(),
      from:     this.peerId,
      to:       toPeerId,
      text,
      itemId,
      ts:       Date.now(),
      read:     false,
      ...(media || {}),  // mediaType, mediaData
    };

    // 本地立刻存储（Optimistic）
    await this.db?.chatMessages?.put({ ...msg, direction: 'out' });
    this.onChat?.({ ...msg, direction: 'out' });

    const dc = this.dataChannels.get(toPeerId);
    if (dc?.readyState === 'open') {
      // Primary: DataChannel is open — send encrypted directly
      const encrypted = await this._encryptChat(toPeerId, msg);
      this._send(toPeerId, { type: 'CHAT', payload: encrypted });
      console.log('[Mesh] Chat sent via DataChannel to', toPeerId.slice(0, 8));
    } else if (this.signaling?.isOnline && typeof this.signaling.sendChat === 'function') {
      // Fallback: Nostr relay — works even without WebRTC connection
      try {
        await this.signaling.sendChat(toPeerId, msg);
        console.log('[Mesh] Chat sent via Nostr relay to', toPeerId.slice(0, 8));
      } catch (nostrErr) {
        console.warn('[Mesh] Nostr chat failed, falling back to Dead Drop:', nostrErr.message);
        await this._storeDeadDrop(toPeerId, msg);
        this.onChat?.({ ...msg, direction: 'out', status: 'queued' });
      }
    } else {
      // Last resort: Dead Drop
      await this._storeDeadDrop(toPeerId, msg);
      this.onChat?.({ ...msg, direction: 'out', status: 'queued' });
      console.log('[Mesh] Chat queued in Dead Drop for', toPeerId.slice(0, 8));
    }
    return msg;
  }

  async _handleChatMsg(fromPeerId, envelope) {
    // Rate-limit: max 10 messages per 5s from any single peer
    this._chatRateLimit = this._chatRateLimit || new Map();
    const rl = this._chatRateLimit.get(fromPeerId) || { count: 0, reset: Date.now() + 5000 };
    if (Date.now() > rl.reset) { rl.count = 0; rl.reset = Date.now() + 5000; }
    rl.count++;
    this._chatRateLimit.set(fromPeerId, rl);
    if (rl.count > 10) { console.warn('[Mesh] Rate limited chat from', fromPeerId.slice(0,8)); return; }

    let msg;
    try {
      // envelope.payload can be:
      //   a) { iv, ciphertext, encrypted:true } — DataChannel AES-GCM
      //   b) plain msg object { id, from, to, text, ts, ... } — Nostr or plaintext DC
      const payload = envelope.payload;
      if (payload && typeof payload === 'object' && !payload.encrypted) {
        // Already a plain message (Nostr path or no-key DataChannel)
        msg = payload;
      } else {
        msg = await this._decryptChat(fromPeerId, payload);
      }
    } catch (err) {
      // Key not yet derived — queue message and retry when key arrives
      if (err.message && err.message.includes('No key')) {
        const q = this._pendingChat.get(fromPeerId) || [];
        q.push({ fromPeerId, envelope });
        this._pendingChat.set(fromPeerId, q);
        console.log('[Mesh] Chat queued (key pending) from', fromPeerId.slice(0,8));
        return;
      }
      console.warn('[Mesh] Chat handling error:', fromPeerId.slice(0,8), err.message);
      return;
    }
    if (!msg || !msg.text) return;

    // Normalise + sanitize required fields
    if (!msg.from) msg.from = fromPeerId;
    if (!msg.to)   msg.to   = this.peerId;
    if (!msg.id)   msg.id   = this._uuid();
    if (!msg.ts)   msg.ts   = Date.now();
    // Sanitize content to prevent stored XSS / oversized payloads
    if (msg.text)      msg.text      = String(msg.text).slice(0, 4000);
    if (msg.from)      msg.from      = String(msg.from).slice(0, 50);
    if (msg.mediaData && msg.mediaData.length > 2 * 1024 * 1024) {
      // 2MB base64 limit (~1.5MB binary) — reject oversized media
      console.warn('[Mesh] mediaData too large, dropping:', msg.from?.slice(0,8));
      delete msg.mediaData;
      delete msg.mediaType;
      msg.text = '[media too large]';
    }

    // Deduplicate: don't store the same message twice (Nostr may deliver via multiple relays)
    if (this.db?.chatMessages) {
      const existing = await this.db.chatMessages.where('id').equals(msg.id).first().catch(() => null);
      if (existing) return; // already stored
    }

    // Store and notify UI
    await this.db?.chatMessages?.put({ ...msg, direction: 'in', read: false });
    this.onChat?.({ ...msg, direction: 'in' });
    console.log('[Mesh] Chat received from', fromPeerId.slice(0,8), ':', msg.text.slice(0,30));

    // Send read receipt (DataChannel only — Nostr doesn't need it)
    this._send(fromPeerId, { type: 'CHAT_READ', msgId: msg.id, ts: Date.now() });
  }

  _handleChatRead(fromPeerId, msg) {
    this.db?.chatMessages?.where('id').equals(msg.msgId).modify({ read: true, readAt: msg.ts });
    this.onChat?.({ type: 'read', msgId: msg.msgId, from: fromPeerId });
  }

  // ─────────────────────────── Dead Drop 离线消息 ───────────────────────────

  async _storeDeadDrop(toPeerId, msg) {
    try {
      await this.db?.deadDrop?.put({
        id:       this._uuid(),
        toPeerId,
        msg,
        createdAt: Date.now(),
        delivered: false,
      });
    } catch (e) {
      console.warn('[Mesh] Dead Drop store failed:', e);
    }
  }

  async _deliverDeadDrop(peerId) {
    const pending = await this.db?.deadDrop
      ?.where('toPeerId').equals(peerId)
      .filter(r => !r.delivered)
      .toArray() ?? [];

    for (const record of pending) {
      try {
        // If ECDH key not yet derived, send plaintext (receiver handles both)
        const payload = await this._encryptChat(peerId, record.msg);
        const sent = this._send(peerId, { type: 'CHAT', payload });
        if (sent) {
          await this.db.deadDrop.update(record.id, { delivered: true, deliveredAt: Date.now() });
        }
      } catch (e) {
        console.warn('[Mesh] Dead Drop delivery error:', e.message);
      }
    }
  }

  async _drainDeadDrop() {
    // 对所有已连接的 peer，尝试投递 Dead Drop
    for (const peerId of this.dataChannels.keys()) {
      await this._deliverDeadDrop(peerId);
    }
  }

  // ─────────────────────────── 图片 P2P 传输 ───────────────────────────

  /**
   * 收到 blob 请求 — 用二进制通道批量发送，比 base64 快 3x
  // ─────────────────────────── Chat media (image/audio) ───────────────────────────

  /**
   * Send a chat image or audio via chunked binary BLOB_STREAM.
   * Avoids the 256KB DataChannel single-message limit.
   *
   * Flow:
   *   sender → CHAT_MEDIA_META (json: msgId, from, to, ts, mediaType, hash, size)
   *   sender → BLOB_STREAM_START + binary chunks + BLOB_STREAM_END
   *   receiver → reassembles blob → fires onChat with dataUrl
   */
  async sendChatMedia(toPeerId, blob, meta) {
    const dc = this.dataChannels.get(toPeerId);
    if (!dc || dc.readyState !== 'open') {
      console.warn('[Mesh] sendChatMedia: no open DataChannel to', toPeerId.slice(0,8));
      return null;
    }

    // Hash = msgId so receiver can correlate blob with message
    const hash = meta.id || this._uuid();
    const msg = { ...meta, id: hash, from: this.peerId, to: toPeerId, ts: meta.ts || Date.now() };

    // Store outgoing message locally first (optimistic)
    try {
      const ab = await blob.arrayBuffer();
      // Announce meta
      dc.send(JSON.stringify({ type: 'CHAT_MEDIA_META', ...msg, hash, size: ab.byteLength }));

      const mime  = blob.type || 'image/jpeg';
      const total = Math.ceil(ab.byteLength / OurBackyardMesh.CHUNK_SIZE);
      dc.send(JSON.stringify({ type: 'BLOB_STREAM_START', hash, mime, total, size: ab.byteLength, chatMsg: true }));

      for (let i = 0; i < total; i++) {
        while (dc.bufferedAmount > OurBackyardMesh.MAX_BUFFER) {
          await new Promise(r => { dc.onbufferedamountlow = r; setTimeout(r, 200); });
        }
        dc.send(ab.slice(i * OurBackyardMesh.CHUNK_SIZE, (i + 1) * OurBackyardMesh.CHUNK_SIZE));
      }
      dc.send(JSON.stringify({ type: 'BLOB_STREAM_END', hash }));

      console.log('[Mesh] Chat media sent:', meta.mediaType, ab.byteLength, 'bytes to', toPeerId.slice(0,8));
      return msg;
    } catch (e) {
      console.warn('[Mesh] sendChatMedia error:', e.message);
      return null;
    }
  }

  /** Store incoming chat media meta so BLOB_STREAM_END can fire onChat */
  _handleChatMediaMeta(fromPeerId, msg) {
    this._chatMediaPending = this._chatMediaPending || new Map();
    this._chatMediaPending.set(msg.hash || msg.id, { ...msg, from: fromPeerId });
  }

  /**
   * Send blobs over DataChannel using BLOB_STREAM_START / binary chunks / BLOB_STREAM_END
   * Supports concurrent pipeline (up to 3 simultaneous transfers)
   */
  async _handleBlobReq(fromPeerId, msg) {
    if (!this.db || !msg.hashes?.length) return;
    const dc = this.dataChannels.get(fromPeerId);
    if (!dc || dc.readyState !== 'open') return;

    const hashes = msg.hashes.slice(0, OurBackyardMesh.BLOB_BATCH);
    const blobs = await this.db.blobs.where('hash').anyOf(hashes).toArray();
    if (!blobs.length) return;

    console.log(`[Mesh] Sending ${blobs.length} blobs to ${fromPeerId}`);

    // Send blobs sequentially with backpressure control
    for (const b of blobs) {
      if (dc.readyState !== 'open') break;
      try {
        const ab = await b.blob.arrayBuffer();
        const hash = b.hash;
        const mime = b.blob.type || 'image/jpeg';
        const total = Math.ceil(ab.byteLength / OurBackyardMesh.CHUNK_SIZE);

        // Send stream header (JSON)
        dc.send(JSON.stringify({
          type: 'BLOB_STREAM_START',
          hash, mime, total, size: ab.byteLength, itemId: b.itemId,
        }));

        // Send binary chunks with backpressure
        for (let i = 0; i < total; i++) {
          if (dc.readyState !== 'open') break;
          while (dc.bufferedAmount > OurBackyardMesh.MAX_BUFFER) {
            await new Promise(r => { dc.onbufferedamountlow = r; setTimeout(r, 100); });
          }
          dc.send(ab.slice(i * OurBackyardMesh.CHUNK_SIZE, (i + 1) * OurBackyardMesh.CHUNK_SIZE));
        }

        // Send stream footer (JSON)
        dc.send(JSON.stringify({ type: 'BLOB_STREAM_END', hash }));

        // Small yield between blobs to avoid starving other messages
        await new Promise(r => setTimeout(r, 5));
      } catch (e) {
        console.warn('[Mesh] BLOB send error:', e.message);
      }
    }
  }

  /** 收到 BLOB_STREAM_START — 初始化流式接收状态 */
  _handleBlobStreamStart(fromPeerId, msg) {
    if (!msg.hash) return;
    this._blobStreams = this._blobStreams || new Map();
    this._blobStreams.set(fromPeerId + ':' + msg.hash, {
      hash: msg.hash, mime: msg.mime || 'image/jpeg',
      itemId: msg.itemId, chunks: [], received: 0, total: msg.total,
    });
  }

  /** 二进制块路由：检查是否有活跃的 blobStream，否则走旧 imgTransfer */
  _routeBinaryChunk(fromPeerId, ab) {
    this._blobStreams = this._blobStreams || new Map();
    // Find any active stream for this peer (sequential, one at a time)
    for (const [key, state] of this._blobStreams) {
      if (key.startsWith(fromPeerId + ':') && state.received < state.total) {
        state.chunks.push(ab);
        state.received++;
        return true; // consumed
      }
    }
    return false; // not consumed, route to old imgTransfer
  }

  /** 收到 BLOB_STREAM_END — 组装 Blob 并存入 DB */
  async _handleBlobStreamEnd(fromPeerId, msg) {
    this._blobStreams = this._blobStreams || new Map();
    const key = fromPeerId + ':' + msg.hash;
    const state = this._blobStreams.get(key);
    if (!state) return;
    this._blobStreams.delete(key);

    try {
      const blob = new Blob(state.chunks, { type: state.mime });
      const existing = await this.db?.blobs.where('hash').equals(state.hash).first();
      if (!existing) {
        await this.db?.blobs.add({
          hash: state.hash, blob,
          itemId: state.itemId, timestamp: Date.now(),
        });
        console.log('[Mesh] Blob received:', state.hash.slice(0, 8), blob.size, 'bytes');
      }
      this._notifyBlobReady(state.hash);

      // Check if this blob was a chat media message
      const chatMeta = this._chatMediaPending?.get(state.hash);
      if (chatMeta) {
        this._chatMediaPending.delete(state.hash);
        // Convert blob to dataUrl and fire onChat
        const reader = new FileReader();
        reader.onload = async () => {
          const mediaMsg = {
            ...chatMeta,
            mediaData: reader.result,
          };
          // Deduplicate
          const exists = await this.db?.chatMessages?.where('id').equals(mediaMsg.id).first().catch(() => null);
          if (!exists) {
            await this.db?.chatMessages?.put({ ...mediaMsg, direction: 'in', read: false });
            this.onChat?.({ ...mediaMsg, direction: 'in' });
          }
        };
        reader.readAsDataURL(blob);
      }
    } catch (e) {
      console.warn('[Mesh] BLOB_STREAM_END error:', e.message);
    }
  }

  /** 触发图片 UI 更新（updateImageInUI 或 p2p-image-ready 事件） */
  _notifyBlobReady(hash) {
    if (typeof window !== 'undefined') {
      if (typeof window.updateImageInUI === 'function') {
        window.updateImageInUI(hash);
      } else {
        window.dispatchEvent(new CustomEvent('p2p-image-ready', { detail: { imageHash: hash } }));
      }
    }
    this.onItem?.({ _blobUpdate: true, imageHash: hash });
  }

  /** 兼容旧节点的 base64 BLOB_RESP（保留向后兼容） */
  async _handleBlobResp(fromPeerId, msg) {
    if (!msg.hash || !msg.data) return;
    try {
      // Efficient base64 decode
      const b64 = msg.data.replace(/[^A-Za-z0-9+/=]/g, '');
      const raw = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      const blob = new Blob([raw], { type: msg.mime || 'image/jpeg' });
      const existing = await this.db?.blobs.where('hash').equals(msg.hash).first();
      if (!existing) {
        await this.db?.blobs.add({ hash: msg.hash, blob, itemId: msg.itemId, timestamp: Date.now() });
      }
      this._notifyBlobReady(msg.hash);
    } catch (e) {
      console.warn('[Mesh] BLOB_RESP decode error:', e.message);
    }
  }

  async sendImage(toPeerId, blob, itemId) {
    const dc = this.dataChannels.get(toPeerId);
    if (!dc || dc.readyState !== 'open') return false;

    const ab     = await blob.arrayBuffer();
    const total  = Math.ceil(ab.byteLength / OurBackyardMesh.CHUNK_SIZE);

    dc.send(JSON.stringify({
      type: 'IMG_HEADER', itemId, total,
      mime: blob.type, size: blob.size,
    }));

    for (let i = 0; i < total; i++) {
      // 背压控制
      while (dc.bufferedAmount > OurBackyardMesh.MAX_BUFFER) {
        await new Promise(r => { dc.onbufferedamountlow = r; setTimeout(r, 200); });
      }
      const chunk = ab.slice(i * OurBackyardMesh.CHUNK_SIZE, (i + 1) * OurBackyardMesh.CHUNK_SIZE);
      dc.send(chunk);
    }

    dc.send(JSON.stringify({ type: 'IMG_END', itemId }));
    return true;
  }

  _startImgTransfer(fromPeerId, msg) {
    this.incomingImg.set(msg.itemId, { chunks: [], total: msg.total, received: 0, mime: msg.mime });
  }

  _handleImgChunk(fromPeerId, ab) {
    // 将二进制块分配给最近开始的传输（简化：先进先出）
    for (const [itemId, state] of this.incomingImg) {
      if (state.received < state.total) {
        state.chunks.push(ab);
        state.received++;
        if (state.received === state.total) {
          const blob = new Blob(state.chunks, { type: state.mime || 'image/jpeg' });
          this.incomingImg.delete(itemId);
          this.db?.blobs?.put({ itemId, blob, ts: Date.now() });
          this.dispatchEvent(new CustomEvent('image', { detail: { itemId, blob } }));
        }
        break;
      }
    }
  }

  _finishImgTransfer(fromPeerId, msg) {
    // IMG_END 作为校验信号（实际 chunk 数量已在 _handleImgChunk 中追踪）
  }

  // ─────────────────────────── 加密工具 ───────────────────────────

  async _deriveSharedKey(peerId, theirPublicKey) {
    if (this.chatKeys.has(peerId)) return this.chatKeys.get(peerId);
    try {
      const sharedKey = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: theirPublicKey },
        this._myECDHKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      this.chatKeys.set(peerId, sharedKey);
      // Drain any messages that arrived before the key was ready
      const pending = this._pendingChat.get(peerId) || [];
      this._pendingChat.delete(peerId);
      for (const { fromPeerId, envelope } of pending) {
        this._handleChatMsg(fromPeerId, envelope).catch(() => {});
      }
      return sharedKey;
    } catch {
      return null;
    }
  }

  async _storeECDHPub(peerId, hexPub) {
    try {
      const raw    = this._hex2ab(hexPub);
      const pubKey = await crypto.subtle.importKey(
        'raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      await this._deriveSharedKey(peerId, pubKey);
    } catch {}
  }

  async _encryptChat(toPeerId, msg) {
    const key = this.chatKeys.get(toPeerId);
    if (!key) return msg;  // 无密钥时降级明文

    const iv         = crypto.getRandomValues(new Uint8Array(12));
    const plaintext  = new TextEncoder().encode(JSON.stringify(msg));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    return {
      iv:         this._ab2hex(iv),
      ciphertext: this._ab2hex(ciphertext),
      encrypted:  true,
    };
  }

  async _decryptChat(fromPeerId, payload) {
    if (!payload?.encrypted) return payload; // plaintext passthrough

    const key = this.chatKeys.get(fromPeerId);
    if (!key) {
      // No ECDH key yet — treat as plaintext if payload has text field
      if (payload && typeof payload === 'object' && payload.text) return payload;
      throw new Error('No key for peer: ' + fromPeerId);
    }

    const iv         = this._hex2ab(payload.iv);
    const ciphertext = this._hex2ab(payload.ciphertext);
    const plaintext  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  // ─────────────────────────── 发送工具 ───────────────────────────

  _send(peerId, msg) {
    const dc = this.dataChannels.get(peerId);
    if (dc?.readyState === 'open') {
      try {
        dc.send(JSON.stringify(msg));
        return true;
      } catch {}
    }
    return false;
  }

  /** 广播给所有已连接节点 */
  _flood(msg) {
    const raw = JSON.stringify(msg);
    for (const [peerId, dc] of this.dataChannels) {
      if (dc.readyState === 'open') {
        try { dc.send(raw); } catch {}
      }
    }
  }

  /** 广播给除 excludePeerId 之外的所有节点（Gossip 转发） */
  _floodExcept(msg, excludePeerId) {
    const raw = JSON.stringify(msg);
    for (const [peerId, dc] of this.dataChannels) {
      if (peerId !== excludePeerId && dc.readyState === 'open') {
        try { dc.send(raw); } catch {}
      }
    }
  }

  /** 统一信令发送（优先 LAN，其次 Nostr） */
  _sendSignal(toPeerId, signal) {
    // Serialize signal to plain JSON — RTCIceCandidate/RTCSessionDescription objects
    // cannot be cloned by BroadcastChannel.postMessage(), must be plain objects.
    const plainSignal = signal && typeof signal.toJSON === 'function'
      ? signal.toJSON()
      : JSON.parse(JSON.stringify(signal));

    // LAN BroadcastChannel (same browser, multiple tabs)
    if (this.lanChannel) {
      try {
        this.lanChannel.postMessage({ type: 'SIGNAL', from: this.peerId, target: toPeerId, signal: plainSignal });
      } catch (e) {
        console.warn('[Mesh] BroadcastChannel postMessage failed:', e.message);
      }
    }
    // Nostr (cross-device)
    this.signaling?.sendSignal(toPeerId, plainSignal).catch(() => {});
  }

  // ─────────────────────────── 心跳 ───────────────────────────

  _heartbeat() {
    const now = Date.now();
    // 检查断线节点
    for (const [peerId, meta] of this.peerMeta) {
      if (now - meta.lastSeen > 60000 && !this.dataChannels.has(peerId)) {
        this.peerMeta.delete(peerId);
      }
    }
    // 重新广播自己（让刚上线的邻居能发现我）
    this._lanAnnounce();
    this.signaling?.announce(this._myECDHPub ? { ecdhPub: this._ab2hex(this._myECDHPub) } : {}).catch(() => {});
    // PING 所有已连接节点
    for (const peerId of this.dataChannels.keys()) {
      this._send(peerId, { type: 'PING', ts: now });
    }
    // 尝试连接已知但未连接的 peer
    for (const [peerId, meta] of this.peerMeta) {
      if (!this.peerConns.has(peerId) && this.peerConns.size < OurBackyardMesh.MAX_PEERS) {
        if (this.peerId < peerId) this._createOffer(peerId).catch(() => {});
      }
    }
  }

  // ─────────────────────────── 工具 ───────────────────────────

  get peerCount()   { return this.dataChannels.size; }
  get networkMode() {
    if (this.dataChannels.size > 0) return 'p2p';
    if (this.signaling?.isOnline) return 'searching';
    return 'offline';
  }

  _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  _ab2hex(ab) {
    return Array.from(new Uint8Array(ab instanceof ArrayBuffer ? ab : ab.buffer ?? ab))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  _hex2ab(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2)
      arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    return arr.buffer;
  }

  destroy() {
    clearInterval(this._hbTimer);
    for (const pc of this.peerConns.values()) pc.close();
    this.lanChannel?.close();
  }
}

if (typeof module !== 'undefined') module.exports = { OurBackyardMesh };
