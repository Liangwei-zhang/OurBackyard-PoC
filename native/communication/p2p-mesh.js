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
  static BLOB_BATCH    = 50;      // max blobs per BLOB_REQ message

  constructor({ peerId, userId = null, h3Cell, db, onItem, onChat, onPeers, onStatus }) {
    super();
    this.peerId   = peerId;
    this.userId   = userId || peerId;
    this.h3Cell   = h3Cell;
    this.db       = db;           // Dexie 实例（用于 Dead Drop）
    this.onItem   = onItem;       // (item) => void
    this.onChat      = onChat;       // (msg) => void
    this.onChannelMsg = null;         // (msg) => void — set by p1p2-features
    this.onPS2Frame = null;           // (msg) => void — set by PS2 adapter
    this.onPeers  = onPeers;      // (count) => void
    this.onStatus = onStatus;     // (mode) => 'nostr'|'lan'|'offline'
    // Phase 3: pluggable publish token verifier.
    // Set via mesh.setPublishVerifier(fn) after boot.
    // fn: async (token: string) => { ok: boolean, reason?: string }
    this._publishVerifier = null;

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
    this.iceServers = this._resolveIceServers();
  }

  _normalizeUserId(userId, fallbackPeerId = null) {
    return userId || fallbackPeerId || null;
  }

  _chatTable() {
    return this.db?.chatMessagesV2 || this.db?.chatMessages || null;
  }

  _resolveIceServers() {
    const defaults = OurBackyardMesh.ICE_SERVERS;
    try {
      const fromWindow = (typeof window !== 'undefined' && Array.isArray(window.__OB_ICE_SERVERS))
        ? window.__OB_ICE_SERVERS
        : null;
      if (fromWindow && fromWindow.length > 0) return fromWindow;

      const raw = (typeof localStorage !== 'undefined')
        ? localStorage.getItem('ourbackyard_ice_servers')
        : null;
      if (!raw) return defaults;

      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      return defaults;
    } catch {
      return defaults;
    }
  }

  async _initPersistentECDH() {
    const keyId = `chat_ecdh_v1:${this.userId || this.peerId}`;

    try {
      const row = await this.db?.userData?.get?.(keyId);
      const payload = row?.value && typeof row.value === 'object' ? row.value : row;
      const privateJwk = payload?.privateJwk || null;
      const publicHex = payload?.publicHex || null;
      if (privateJwk && publicHex) {
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          privateJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveKey']
        );
        this._myECDHKey = privateKey;
        this._myECDHPub = this._hex2ab(publicHex);
        console.log('[Mesh] Loaded persistent ECDH keypair');
        return true;
      }
    } catch (e) {
      console.warn('[Mesh] ECDH load failed, regenerating keypair:', e?.message || e);
    }

    try {
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
      const rawPub = await crypto.subtle.exportKey('raw', pair.publicKey);
      const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      this._myECDHKey = pair.privateKey;
      this._myECDHPub = rawPub;

      await this.db?.userData?.put?.({
        key: keyId,
        value: {
          privateJwk,
          publicHex: this._ab2hex(rawPub),
          ts: Date.now(),
        },
        ts: Date.now(),
      }).catch(() => {});

      console.log('[Mesh] Generated and persisted ECDH keypair');
      return true;
    } catch (e) {
      console.warn('[Mesh] ECDH generate failed:', e?.message || e);
      return false;
    }
  }

  _isPeerDcOpen(peerId) {
    return this.dataChannels.get(peerId)?.readyState === 'open';
  }

  _isPeerRouteUsable(peerId, now = Date.now()) {
    if (!peerId) return false;
    if (this._isPeerDcOpen(peerId)) return true;
    const pcState = this.peerConns.get(peerId)?.connectionState;
    if (pcState && !['failed', 'closed', 'disconnected'].includes(pcState)) return true;
    const lastSeen = Number(this.peerMeta.get(peerId)?.lastSeen || 0);
    return lastSeen > 0 && (now - lastSeen) < 45000;
  }

  _selectBestPeerForUser(userId, excludePeerId = null) {
    if (!userId) return null;
    const candidates = [...this.peerMeta.entries()]
      .filter(([peerId, meta]) =>
        peerId !== excludePeerId &&
        this._normalizeUserId(meta?.userId, meta?.peerId || peerId) === userId
      )
      .sort((a, b) => {
        const aOpen = this._isPeerDcOpen(a[0]) ? 1 : 0;
        const bOpen = this._isPeerDcOpen(b[0]) ? 1 : 0;
        if (aOpen !== bOpen) return bOpen - aOpen;
        return Number(b[1]?.lastSeen || 0) - Number(a[1]?.lastSeen || 0);
      });
    return candidates[0]?.[0] || null;
  }

  _bindPeerUser(peerId, userId, metaPatch = null) {
    if (!peerId) return;
    const now = Date.now();
    const normalizedUserId = this._normalizeUserId(userId, peerId);
    const prevMeta = this.peerMeta.get(peerId) || {};
    this.peerMeta.set(peerId, {
      ...prevMeta,
      ...(metaPatch || {}),
      peerId,
      userId: normalizedUserId,
      lastSeen: now,
    });
    this._userRoutes = this._userRoutes || new Map();
    const prevRoute = this._userRoutes.get(normalizedUserId);
    const dcState = this.dataChannels.get(peerId)?.readyState;
    const prevDcState = this.dataChannels.get(prevRoute?.peerId)?.readyState;
    const isPrevRouteStale = !prevRoute || (now - Number(prevRoute.lastSeen || 0)) > 15000;
    const shouldReplace =
      !prevRoute ||
      prevRoute.peerId === peerId ||
      (dcState === 'open' && prevDcState !== 'open') ||
      isPrevRouteStale;
    if (shouldReplace) {
      this._userRoutes.set(normalizedUserId, { peerId, lastSeen: now });
    }
  }

  _unbindPeerRoute(peerId) {
    if (!peerId || !this._userRoutes?.size) return;
    for (const [userId, route] of this._userRoutes.entries()) {
      if (route?.peerId === peerId) {
        const fallbackPeerId = this._selectBestPeerForUser(userId, peerId);
        if (fallbackPeerId) {
          this._userRoutes.set(userId, { peerId: fallbackPeerId, lastSeen: Date.now() });
        } else {
          this._userRoutes.delete(userId);
        }
      }
    }
  }

  _pruneStalePeers(now = Date.now()) {
    for (const [peerId, dc] of [...this.dataChannels.entries()]) {
      if (!dc || dc.readyState === 'closed') {
        this.dataChannels.delete(peerId);
        this._unbindPeerRoute(peerId);
      }
    }

    for (const [peerId, pc] of [...this.peerConns.entries()]) {
      if (!pc) {
        this.peerConns.delete(peerId);
        continue;
      }
      const st = pc.connectionState;
      if (st === 'closed' || st === 'failed') {
        this._cleanPeer(peerId);
      }
    }

    for (const [peerId, meta] of [...this.peerMeta.entries()]) {
      const lastSeen = Number(meta?.lastSeen || 0);
      if (!this._isPeerDcOpen(peerId) && now - lastSeen > 45000) {
        this.peerMeta.delete(peerId);
        this._unbindPeerRoute(peerId);
        if (this.peerConns.has(peerId)) this._cleanPeer(peerId);
      }
    }
  }

  _evictPeerForCapacity() {
    const candidates = [...this.peerMeta.entries()]
      .filter(([peerId]) => !this._isPeerDcOpen(peerId))
      .sort((a, b) => Number(a[1]?.lastSeen || 0) - Number(b[1]?.lastSeen || 0));
    const victim = candidates[0]?.[0];
    if (!victim) return false;
    this._cleanPeer(victim);
    this.peerMeta.delete(victim);
    this._unbindPeerRoute(victim);
    return true;
  }

  _normalizeItemIdentity(item = {}, fallbackOwner = null) {
    const ownerUserId = item?.ownerUserId || item?.sellerId || fallbackOwner || null;
    const sellerId = item?.sellerId || ownerUserId || fallbackOwner || null;
    return {
      ...item,
      ownerUserId,
      sellerId,
    };
  }

  _canonicalItemId(item = {}) {
    const raw = item?.itemId ?? item?.originalId ?? item?.id ?? null;
    return raw == null ? null : String(raw);
  }

  _itemKey(item = {}, fallbackOwner = null) {
    const owner = item?.ownerUserId || item?.sellerId || fallbackOwner || null;
    const canonicalId = this._canonicalItemId(item);
    if (canonicalId && canonicalId.includes(':')) return canonicalId;
    return owner && canonicalId ? `${owner}:${canonicalId}` : null;
  }

  _resolvePeerTarget(targetId) {
    const now = Date.now();
    if (!targetId) return null;
    if (this._isPeerRouteUsable(targetId, now)) {
      return targetId; // already a session peer id
    }
    const cachedRoute = this._userRoutes?.get(targetId)?.peerId;
    if (cachedRoute && this._isPeerRouteUsable(cachedRoute, now)) {
      return cachedRoute;
    }
    const candidates = [...this.peerMeta.entries()]
      .filter(([, meta]) => this._normalizeUserId(meta?.userId, meta?.peerId) === targetId)
      .sort((a, b) => {
        const aOpen = this.dataChannels.get(a[0])?.readyState === 'open' ? 1 : 0;
        const bOpen = this.dataChannels.get(b[0])?.readyState === 'open' ? 1 : 0;
        if (aOpen !== bOpen) return bOpen - aOpen;
        return Number(b[1]?.lastSeen || 0) - Number(a[1]?.lastSeen || 0);
      });
    return candidates[0]?.[0] || targetId;
  }

  _resolveUserId(peerId) {
    const meta = this.peerMeta.get(peerId);
    if (meta?.userId) return meta.userId;
    if (this._userRoutes?.size) {
      for (const [userId, route] of this._userRoutes.entries()) {
        if (route?.peerId === peerId) return userId;
      }
    }
    return this._normalizeUserId(meta?.userId, meta?.peerId || peerId);
  }

  resolvePeerTarget(targetId) {
    return this._resolvePeerTarget(targetId);
  }

  listActiveUsers() {
    const users = [...this.dataChannels.keys()]
      .map((peerId) => this._resolveUserId(peerId))
      .filter(Boolean);
    return [...new Set(users)];
  }

  _onlineUserCount(extraPeerId = null) {
    const users = new Set(this.listActiveUsers());
    if (extraPeerId) users.add(this._resolveUserId(extraPeerId));
    return users.size;
  }

  // ─────────────────────────── 初始化 ───────────────────────────

  async init() {
    // 初始化(或恢复) ECDH 密钥对：持久化后可避免刷新导致频繁换钥。
    await this._initPersistentECDH();
    if (!this._myECDHKey || !this._myECDHPub) {
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
      this._myECDHKey = pair.privateKey;
      this._myECDHPub = await crypto.subtle.exportKey('raw', pair.publicKey);
    }

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

    console.log('[Mesh] Initialized, session:', this.peerId, 'user:', this.userId);
    try {
      const labels = (this.iceServers || []).map((s) => s?.urls).filter(Boolean);
      console.log('[Mesh] ICE servers:', labels);
    } catch {}
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
      userId:    this.userId,
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
      userId: this.userId,
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
        if (data.target === this.peerId || data.target === this.userId) {
          this._handleSignal(data.from, data.signal);
        }
        break;
    }
  }

  async _onPeerAnnounce(peerId, meta) {
    // Validate peerId format to prevent injection via crafted Nostr events
    if (!peerId || typeof peerId !== 'string' || peerId.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(peerId)) return;
    if (peerId === this.peerId) return;
    const announcedUserId = this._normalizeUserId(meta?.userId, meta?.peerId || peerId);
    const existingPc = this.peerConns.get(peerId);
    if (existingPc) {
      const st = existingPc.connectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        this._cleanPeer(peerId);
      } else {
        this._bindPeerUser(peerId, announcedUserId, { ...meta, lastSeen: Date.now() });
        return;
      }
    }

    this._pruneStalePeers();
    if (this.peerConns.size >= OurBackyardMesh.MAX_PEERS && !this._evictPeerForCapacity()) return;

    const normalizedMeta = {
      ...meta,
      userId: announcedUserId,
      lastSeen: Date.now(),
    };
    this._bindPeerUser(peerId, normalizedMeta.userId, normalizedMeta);

    const existingRoutePeerId = this._userRoutes?.get(announcedUserId)?.peerId;
    if (existingRoutePeerId && existingRoutePeerId !== peerId && !this._isPeerDcOpen(existingRoutePeerId)) {
      this._cleanPeer(existingRoutePeerId);
      this.peerMeta.delete(existingRoutePeerId);
      this._unbindPeerRoute(existingRoutePeerId);
      this._bindPeerUser(peerId, announcedUserId, normalizedMeta);
    }

    // 保存对方 ECDH 公钥（若轮换则自动刷新 shared key）
    if (normalizedMeta.ecdhPub) {
      await this._storeECDHPub(peerId, normalizedMeta.ecdhPub);
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
      setTimeout(() => window.connectToPeer(normalizedMeta.userId || peerId), 1500);
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
    // ── Per-peer signaling mutex ──────────────────────────────────────────────
    // 7 Nostr relays deliver the same offer/answer almost simultaneously.
    // _handleSignal is async, so without a lock the state-check and the
    // setRemoteDescription await are NOT atomic:
    //   relay 1 → check passes (have-local-offer) → await setRemoteDescription…
    //   relay 2 → check passes (still have-local-offer, relay 1 hasn't finished)
    //           → await setRemoteDescription → ERROR: Called in wrong state: stable
    // Fix: set a synchronous per-peer in-flight flag BEFORE the first await.
    this._signalingLocks = this._signalingLocks || new Set();

    switch (signal.type) {
      case 'offer': {
        if (signal.ecdhPub) await this._storeECDHPub(peerId, signal.ecdhPub);

        let pc = this.peerConns.get(peerId);

        if (pc) {
          const state = pc.signalingState;
          if (state === 'stable') return; // already connected — ignore re-offer
          if (state === 'have-local-offer') {
            // Glare: both sent offers. Lower peerId wins (they become answerer).
            if (this.peerId > peerId) {
              try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
            } else {
              return; // We win — wait for their answer
            }
          }
          if (pc.signalingState !== 'stable') {
            pc.close();
            this.peerConns.delete(peerId);
            pc = null;
          }
        }

        // Acquire lock before any async work
        const offerKey = peerId + ':offer';
        if (this._signalingLocks.has(offerKey)) return; // duplicate offer in-flight
        this._signalingLocks.add(offerKey);

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
        } finally {
          this._signalingLocks.delete(offerKey);
        }
        break;
      }
      case 'answer': {
        if (signal.ecdhPub) await this._storeECDHPub(peerId, signal.ecdhPub);
        const pc = this.peerConns.get(peerId);
        if (!pc) return;

        // Synchronous guard: must be in have-local-offer AND no other answer in-flight
        const answerKey = peerId + ':answer';
        if (this._signalingLocks.has(answerKey)) return; // duplicate answer in-flight
        if (pc.signalingState !== 'have-local-offer') return; // already applied or wrong state
        this._signalingLocks.add(answerKey); // claim the lock before any await

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        } catch (e) {
          // Silently ignore: duplicate answers from multiple Nostr relays are expected
          if (!e.message?.includes('stable')) {
            console.warn('[Mesh] answer handling error:', e.message);
          }
        } finally {
          this._signalingLocks.delete(answerKey);
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
    const pc = new RTCPeerConnection({ iceServers: this.iceServers || OurBackyardMesh.ICE_SERVERS });

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
        this.onPeers?.(this._onlineUserCount(peerId));
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
      this._bindPeerUser(peerId, this.peerMeta.get(peerId)?.userId || null);
      this.onPeers?.(this._onlineUserCount());
      // Deliver any queued dead-drop messages (incl. media) now that DC is open
      setTimeout(() => this._deliverDeadDrop(peerId), 500);
      // Receiver-side: ask sender to re-deliver any media stuck in "waiting" state.
      // This handles the case where sender's Dead Drop didn't fire (app was closed/reloaded).
      setTimeout(() => this._requestPendingMedia(peerId), 1500);
      // Retry ECDH pub exchange after 3s if key still not established
      // (guards against race where first ECDH_PUB send fails silently)
      setTimeout(() => {
        if (!this.chatKeys.has(peerId) && this._myECDHPub && dc.readyState === 'open') {
          this._sendMyECDHPub(peerId);
          console.log('[Mesh] ECDH retry for', peerId.slice(0,8));
        }
      }, 3000);
      // Send our ECDH public key directly over DataChannel so the peer
      // can derive the shared key immediately — no need to wait for Nostr announce
      this._sendMyECDHPub(peerId);
      // 连接成功后发送本节点的最新物品列表摘要（增量同步触发）
      this._requestSync(peerId);
      // 投递 Dead Drop 中对方的离线消息
      this._deliverDeadDrop(peerId);
      // Re-request any blobs we're still missing from this new peer
      setTimeout(async () => {
        try {
          if (!this.db) return;
          // Find all item image hashes we have items for but no blobs
          const items = await this.db.items.toArray();
          const wantHashes = new Set();
          items.forEach(item => {
            const hashes = item.imageHashes?.length ? item.imageHashes : (item.imageHash ? [item.imageHash] : []);
            hashes.forEach(h => h && wantHashes.add(h));
          });
          if (!wantHashes.size) return;
          const have = await this.db.blobs.where('hash').anyOf([...wantHashes]).toArray();
          const haveSet = new Set(have.map(b => b.hash));
          const need = [...wantHashes].filter(h => !haveSet.has(h));
          if (need.length > 0) {
            console.log(`[Mesh] New peer ${peerId.slice(0,8)}: requesting ${need.length} missing blobs`);
            for (let i = 0; i < need.length; i += this.constructor.BLOB_BATCH) {
              const batch = need.slice(i, i + this.constructor.BLOB_BATCH);
              setTimeout(() => this._send(peerId, { type: 'BLOB_REQ', hashes: batch }), i * 200);
            }
          }
        } catch(e) { console.warn('[Mesh] dc.onopen blob request failed:', e.message); }
      }, 2000); // 2s delay: let item SYNC_RESP complete first

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
      // ── Clean up receive-side blob streams for this peer ──
      if (this._blobStreams) {
        const prefix = peerId + ':';
        for (const key of [...this._blobStreams.keys()]) {
          if (key.startsWith(prefix)) {
            const state = this._blobStreams.get(key);
            this._blobStreams.delete(key);
            if (state?.hash) {
              console.log('[Mesh] DC closed mid-stream, re-queuing:', state.hash?.slice(0,8));
              setTimeout(() => this._requestBlobFromPeers(state.hash, state.itemId), 2000);
            }
          }
        }
      }
      // ── Clean up send-side queue for this peer ──
      if (this._blobSendQueues)  this._blobSendQueues.delete(peerId);
      if (this._blobSendRunning) this._blobSendRunning.delete(peerId);

      this.dataChannels.delete(peerId);
      this._unbindPeerRoute(peerId);
      this.onPeers?.(this._onlineUserCount());
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
                                'CHAT','CHAT_READ','PING','PONG'];
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
    this._unbindPeerRoute(peerId);
    this.onPeers?.(this._onlineUserCount());
  }

  // ─────────────────────────── 数据接收路由 ───────────────────────────

  async _onData(fromPeerId, raw) {
    // 二进制 → 优先走 blob stream，否则走旧 imgTransfer
    if (raw instanceof ArrayBuffer) {
      this._routeBinaryChunk(fromPeerId, raw);
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    this._bindPeerUser(fromPeerId, this.peerMeta.get(fromPeerId)?.userId || null);

    switch (msg.type) {
      case 'ITEM':         return this._handleItem(fromPeerId, msg.item);
      case 'ITEM_UPDATE':  return this._handleItemUpdate(fromPeerId, msg);
      // Aliases for inline system message types (keeps both protocols working)
      case 'NEW_ITEM':     return this._handleItem(fromPeerId, msg.item);
      case 'SYNC_REQ':     return this._handleSyncReq(fromPeerId, msg);
      case 'SYNC_RESP':     return this._handleSyncResp(fromPeerId, msg);
      case 'SYNC_RESPONSE': return this._handleSyncResp(fromPeerId, msg);
      case 'CHAT':         return this._handleChatMsg(fromPeerId, msg);
      case 'MEDIA_REREQUEST': return this._handleMediaRerequest(fromPeerId, msg);
      case 'CHAT_READ':    return this._handleChatRead(fromPeerId, msg);

      case 'PING':         return this._send(fromPeerId, { type: 'PONG', ts: msg.ts });
      case 'ECDH_PUB':     return this._storeECDHPub(fromPeerId, msg.ecdhPub || msg.pub);
      // Chat media announcement: stores meta so BLOB_STREAM_END can fire onChat
      case 'CHAT_MEDIA_META': return this._handleChatMediaMeta(fromPeerId, msg);
      case 'PS2_FRAME':
        if (msg?.frame?.from) {
          this._bindPeerUser(fromPeerId, msg.frame.from);
        }
        if (typeof this.onPS2Frame === 'function') {
          try { return this.onPS2Frame(msg); } catch {}
        }
        return;
      // CHANNEL_MSG: route to window.handleMessage for p1p2-features _listenChannelMsgs
      case 'CHANNEL_MSG':
        // Validate CHANNEL_MSG structure
        if (msg.channel && typeof msg.channel === 'string' && msg.channel.length <= 40 &&
            msg.text && typeof msg.text === 'string' && msg.text.length <= 2000) {
          // Notify registered callback (p1p2-features _listenChannelMsgs)
          if (this.onChannelMsg) {
            try { this.onChannelMsg(msg); } catch {}
          }
          // Also route through window.handleMessage for backwards compat
          if (typeof window !== 'undefined' && typeof window.handleMessage === 'function') {
            try { window.handleMessage(raw); } catch {}
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
    const normalizedItem = this._normalizeItemIdentity(item, this.userId || this.peerId);
    const msg = { type: 'ITEM', item: normalizedItem, ttl };
    this._flood(msg);
  }

  async broadcastItemUpdate(itemOrId, statusOrNull) {
    let item = typeof itemOrId === 'object' && itemOrId !== null ? itemOrId : null;
    if (!item && this.db?.items && itemOrId !== undefined && itemOrId !== null) {
      item = await this.db.items.get(itemOrId).catch(() => null);
    }

    const itemId = item?.itemId ?? item?.id ?? itemOrId;
    const status = statusOrNull ?? item?.status;
    if (itemId === undefined || itemId === null || !status) return false;
    const ownerUserId = item?.ownerUserId || item?.sellerId || this.userId || this.peerId;
    const sellerId = item?.sellerId || ownerUserId || this.userId || this.peerId;

    const msg = {
      type: 'ITEM_UPDATE',
      itemId,
      status,
      timestamp: Date.now(),
      updatedAt: item?.updatedAt || Date.now(),
      sellerId,
      ownerUserId,
      title: item?.title,
      price: item?.price,
      description: item?.description,
      category: item?.category,
      imageHash: item?.imageHash || null,
      imageHashes: item?.imageHashes || [],
      ttl: 4,
      from: this.userId || this.peerId,
    };

    if (typeof window !== 'undefined' && window.DIDService?.sign) {
      try {
        msg.signature = await window.DIDService.sign(this._canonicalItemUpdate(msg));
        msg.did = window.DIDService.getDID?.();
      } catch (err) {
        console.warn('[Mesh] ITEM_UPDATE signing failed:', err?.message || err);
      }
    }

    this._flood(msg);
    return true;
  }

  _handleItem(fromPeerId, item) {
    // Accept items with either id or itemId (DB uses ++id, not itemId)
    const localId = item?.id ?? item?.itemId;
    if (!item || (localId === undefined && !item.title)) return;

    // ── Phase 3: verify publish token ────────────────────────────────────
    // If a verifier is registered AND the item carries a token, verify it.
    // Items without a token are accepted if no verifier is set (backward compat).
    // Items with an INVALID token are rejected silently — not stored, not gossiped.
    if (this._publishVerifier && item.publishToken) {
      // Async verification: run in background, store optimistically ONLY if ok.
      // We clone the item first so closure captures the right reference.
      const _item = item;
      const _from = fromPeerId;
      this._publishVerifier(_item.publishToken).then(result => {
        if (!result.ok) {
          console.warn('[Mesh] P3 reject: invalid publishToken from',
            _from.slice(0, 8), '—', result.reason, '— item:', _item.title);
          return; // do NOT store or gossip
        }
        this._storeAndGossip(_from, _item);
      }).catch(() => {
        // Verifier threw — accept item (fail open, don't break normal flow)
        this._storeAndGossip(_from, _item);
      });
      return; // handled asynchronously above
    }

    this._storeAndGossip(fromPeerId, item);
  }

  /** Phase 3 helper: store item in DB and gossip to neighbours.
   *  Called from _handleItem (sync path) and from the async token verifier. */
  _storeAndGossip(fromPeerId, item) {
    const normalizedItem = this._normalizeItemIdentity(item, this._resolveUserId(fromPeerId));
    const ownerUserId = normalizedItem.ownerUserId || normalizedItem.sellerId || null;
    const canonicalItemId = this._canonicalItemId(normalizedItem);
    const itemKey = this._itemKey(normalizedItem, ownerUserId);
    const storeItem = {
      ...normalizedItem,
      itemId: normalizedItem.itemId ?? canonicalItemId,
      originalId: normalizedItem.originalId ?? canonicalItemId,
      itemKey: normalizedItem.itemKey || itemKey || null,
      imageHashes: Array.isArray(normalizedItem.imageHashes)
        ? normalizedItem.imageHashes
        : (normalizedItem.imageHash ? [normalizedItem.imageHash] : []),
      _receivedFrom: fromPeerId,
    };
    if (!storeItem.imageHash && storeItem.imageHashes.length) {
      storeItem.imageHash = storeItem.imageHashes[0];
    }
    delete storeItem.id;
    delete storeItem.publishToken; // don't persist licence token in local DB

    // Upsert by canonical itemKey first, then by owner+timestamp/title fallback.
    if (this.db) {
      const queryByOwnerFallback = () => this.db.items
        .where('timestamp').equals(normalizedItem.timestamp || 0)
        .filter(i => (i.ownerUserId || i.sellerId || null) === ownerUserId)
        .first()
        .then(existing => {
          if (existing) return existing;
          return this.db.items
            .where('title').equals(normalizedItem.title || '')
            .filter(i => (i.ownerUserId || i.sellerId || null) === ownerUserId)
            .first();
        });

      const upsertExisting = async (existing) => {
        if (!existing?.id) return this.db.items.add(storeItem).catch(() => {});
        const existingTs = Number(existing.updatedAt || existing.timestamp || 0);
        const incomingTs = Number(storeItem.updatedAt || storeItem.timestamp || 0);
        const mergedHashes = [...new Set([...(existing.imageHashes || []), ...(storeItem.imageHashes || [])].filter(Boolean))];
        const next = {
          ...(existing || {}),
          ...(incomingTs >= existingTs ? storeItem : {}),
          itemId: existing.itemId ?? storeItem.itemId ?? null,
          originalId: existing.originalId ?? storeItem.originalId ?? null,
          itemKey: existing.itemKey || storeItem.itemKey || null,
          imageHashes: mergedHashes,
          imageHash: (incomingTs >= existingTs ? (storeItem.imageHash || existing.imageHash) : (existing.imageHash || storeItem.imageHash)) || mergedHashes[0] || null,
        };
        return this.db.items.update(existing.id, next).catch(() => {});
      };

      const byItemKey = storeItem.itemKey
        ? this.db.items.where('itemKey').equals(storeItem.itemKey).first().catch(() => null)
        : Promise.resolve(null);

      byItemKey
        .then((existing) => existing || queryByOwnerFallback())
        .then((existing) => upsertExisting(existing))
        .catch(() => {}); // On query error: skip (don't add blindly)
    }

    this.onItem?.(normalizedItem);

    // Gossip 转发（TTL 递减）
    const ttl = (normalizedItem._ttl ?? 4) - 1;
    if (ttl > 0) {
      const msg = { type: 'ITEM', item: { ...normalizedItem, _ttl: ttl }, ttl };
      this._floodExcept(msg, fromPeerId);
    }
  
  }
  async _handleItemUpdate(fromPeerId, msg) {
    if (!this.db?.items || msg?.itemId === undefined || msg?.itemId === null) return;

    const incomingOwner = msg?.ownerUserId || msg?.sellerId || null;
    const incomingItemKey = this._itemKey({ itemId: msg.itemId, ownerUserId: incomingOwner, sellerId: incomingOwner });
    const localByItemKey = incomingItemKey
      ? await this.db.items.where('itemKey').equals(incomingItemKey).first().catch(() => null)
      : null;
    const localByCanonicalId = !localByItemKey
      ? await this.db.items
        .where('itemId')
        .anyOf([String(msg.itemId), msg.itemId])
        .filter((i) => !incomingOwner || (i.ownerUserId || i.sellerId || null) === incomingOwner)
        .first()
        .catch(() => null)
      : null;
    const localByPrimaryKey = !localByItemKey && !localByCanonicalId ? await this.db.items.get(msg.itemId).catch(() => null) : null;
    const localItem = localByItemKey || localByCanonicalId || localByPrimaryKey;
    const localOwner = localItem?.ownerUserId || localItem?.sellerId || null;

    if (localOwner && incomingOwner && localOwner !== incomingOwner) {
      console.warn('[Mesh] Rejecting ITEM_UPDATE with owner mismatch:', msg.itemId);
      return;
    }

    if (msg.signature && msg.did && typeof window !== 'undefined' && window.DIDService?.verify) {
      const isValid = await window.DIDService.verify(
        this._canonicalItemUpdate(msg),
        msg.signature,
        msg.did
      ).catch(() => false);
      if (!isValid) {
        console.warn('[Mesh] Rejecting ITEM_UPDATE with invalid signature:', msg.itemId);
        return;
      }
    }

    const incomingUpdatedAt = msg.updatedAt || msg.timestamp || Date.now();
    if (localItem?.updatedAt && incomingUpdatedAt <= localItem.updatedAt) {
      return;
    }
    const ownerUserId = incomingOwner || localOwner || this._resolveUserId(fromPeerId);
    const sellerId = msg.sellerId || msg.ownerUserId || localItem?.sellerId || ownerUserId || null;
    const canonicalItemId = String(localItem?.itemId ?? msg.itemId);
    const mergedImageHashes = [...new Set([
      ...(Array.isArray(localItem?.imageHashes) ? localItem.imageHashes : (localItem?.imageHash ? [localItem.imageHash] : [])),
      ...(Array.isArray(msg.imageHashes) ? msg.imageHashes : (msg.imageHash ? [msg.imageHash] : [])),
    ].filter(Boolean))];

    const nextItem = {
      ...(localItem || {}),
      ...(msg.title !== undefined ? { title: msg.title } : {}),
      ...(msg.price !== undefined ? { price: msg.price } : {}),
      ...(msg.description !== undefined ? { description: msg.description } : {}),
      ...(msg.category !== undefined ? { category: msg.category } : {}),
      imageHashes: mergedImageHashes,
      imageHash: msg.imageHash || localItem?.imageHash || mergedImageHashes[0] || null,
      itemId: canonicalItemId,
      originalId: localItem?.originalId ?? canonicalItemId,
      itemKey: localItem?.itemKey || this._itemKey({ itemId: canonicalItemId, ownerUserId, sellerId }) || null,
      sellerId,
      ownerUserId,
      status: msg.status,
      timestamp: localItem?.timestamp || msg.timestamp || incomingUpdatedAt,
      updatedAt: incomingUpdatedAt,
    };

    if (localItem?.id) {
      await this.db.items.update(localItem.id, nextItem).catch(() => {});
    } else {
      await this.db.items.put(nextItem).catch(() => {});
    }

    this.onItem?.({ ...nextItem, id: localItem?.id ?? msg.itemId });

    const ttl = (msg.ttl ?? 1) - 1;
    if (fromPeerId && ttl > 0) {
      this._floodExcept({ ...msg, ttl }, fromPeerId);
    }
  }

  // ─────────────────────────── 增量同步（替换服务器历史物品推送） ───────────────────────────

  async _requestSync(peerId) {
    // 1. 发送 items 同步请求
    const items = await this.db?.items.orderBy('timestamp').reverse().limit(100).toArray() ?? [];
    const ids = items.map(i => ((i.ownerUserId || i.sellerId || '') + ':' + (i.timestamp || 0)));
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
    // 找出对方没有的物品（用 ownerUserId/sellerId + timestamp 做可移植去重键）
    const allItems = await this.db?.items
      .where('timestamp').above(msg.since ?? 0)
      .toArray() ?? [];
    const missing = allItems.filter(i => {
      const key = (i.ownerUserId || i.sellerId || '') + ':' + (i.timestamp || 0);
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
            // Send remaining batches with staggered delays to avoid overwhelming the channel
            let offset = OurBackyardMesh.BLOB_BATCH;
            const sendNextBatch = () => {
              if (offset >= need.length) return;
              if (!this.dataChannels.has(fromPeerId)) {
                // Peer disconnected — also try other peers
                this._requestMissingBlobsFromAll(need.slice(offset));
                return;
              }
              const batch = need.slice(offset, offset + OurBackyardMesh.BLOB_BATCH);
              this._send(fromPeerId, { type: 'BLOB_REQ', hashes: batch });
              offset += OurBackyardMesh.BLOB_BATCH;
              setTimeout(sendNextBatch, 1500);
            };
            setTimeout(sendNextBatch, 1500);
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
  async sendChat(toPeerId, text, itemId = null, media = null, _overrideMsg = null) {
    const logicalTo = toPeerId;
    const routePeerId = this._resolvePeerTarget(toPeerId);
    const relayTargetId = logicalTo || routePeerId;
    // For relay fallback, prefer the freshest known session for this user.
    // This avoids encrypting to a stale session key right after the peer refreshes.
    const relayEncryptPeerId = this._selectBestPeerForUser(logicalTo) || routePeerId || logicalTo;
    const routeLabel = String(routePeerId || logicalTo || '').slice(0, 8);
    const msg = _overrideMsg || {
      id:       this._uuid(),
      from:     this.userId || this.peerId,
      to:       logicalTo,
      senderUserId: this.userId || this.peerId,
      recipientUserId: logicalTo,
      text,
      itemId,
      ts:       Date.now(),
      read:     false,
      ...(media || {}),  // mediaType, mediaData
    };
    if (!msg.from) msg.from = this.userId || this.peerId;
    if (!msg.to) msg.to = logicalTo;
    if (!msg.senderUserId) msg.senderUserId = msg.from;
    if (!msg.recipientUserId) msg.recipientUserId = msg.to;

    // Skip DB storage and UI notification for call signals (call-offer, call-answer, etc.)
    // They piggyback on the chat channel but must not appear in chat history or inbox.
    if (msg.type && msg.type.startsWith('call-')) {
      // Just send — no local store, no UI echo
    } else {
      // 本地立刻存储（Optimistic）
      await this._chatTable()?.put?.({ ...msg, direction: 'out' });
      this.onChat?.({ ...msg, direction: 'out' });
    }

    const dc = routePeerId ? this.dataChannels.get(routePeerId) : null;
    if (dc?.readyState === 'open') {
      // If message contains media (image/audio dataUrl), route through sendChatMedia
      // to avoid the ~256KB DataChannel single-message JSON limit.
      // Strip mediaData from the JSON envelope and send it as binary BLOB_STREAM.
      if (msg.mediaData && typeof msg.mediaData === 'string' && msg.mediaData.startsWith('data:')) {
        // Media messages: use binary BLOB_STREAM to avoid the ~256KB DC JSON limit.
        // sendChatMedia handles CHAT_MEDIA_META + BLOB_STREAM + local DB store — 
        // do NOT also send a CHAT envelope or the receiver gets a duplicate bubble.
        const dataUrl = msg.mediaData;
        const mime    = dataUrl.split(';')[0].split(':')[1] || 'image/jpeg';
        const b64     = dataUrl.split(',')[1] || '';
        const raw     = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const blob    = new Blob([raw], { type: mime });
        await this.sendChatMedia(routePeerId || logicalTo, blob, {
          id:        msg.id,
          from:      msg.from,
          to:        msg.to,
          ts:        msg.ts,
          itemId:    msg.itemId,
          mediaType: msg.mediaType,
          text:      msg.text,
        });
        console.log('[Mesh] Chat media sent via BLOB_STREAM to', routeLabel);
      } else {
        // Text / call-signal: small enough for a single DC message
        try {
          const encrypted = await this._encryptChat(routePeerId || logicalTo, msg);
          this._send(routePeerId || logicalTo, { type: 'CHAT', payload: encrypted });
          console.log('[Mesh] Chat sent via DataChannel to', routeLabel);
        } catch (err) {
          if (!String(err?.message || '').includes('No key')) throw err;
          await this._storeDeadDrop(routePeerId || logicalTo, msg);
          this.onChat?.({ ...msg, direction: 'out', status: 'queued' });
          this._kickstartChatRoute(routePeerId || logicalTo);
          console.log('[Mesh] Chat queued until ECDH key is ready for', routeLabel);
        }
      }
    } else if (this.signaling?.isOnline && typeof this.signaling.sendChat === 'function') {
      // Fallback: Nostr relay — works without WebRTC, but max ~48KB payload.
      // Strip large mediaData (images/audio) — they require DataChannel BLOB_STREAM.
      // Exception: _hasFullRes means this is already a compressed preview, send it via Nostr.
      // Queue them for delivery once DC connects.
      if (!this._canRelayChatViaNostr(msg)) {
        // Too large for Nostr — store in Dead Drop for DC delivery
        await this._storeDeadDrop(routePeerId || logicalTo, msg);
        this.onChat?.({ ...msg, direction: 'out', status: 'queued' });
        this._kickstartChatRoute(routePeerId || logicalTo);
        console.log('[Mesh] Media queued for DC delivery (too large for Nostr):', routeLabel);

        // Notify recipient via Nostr so they know a media message is waiting.
        // The actual media is held in Dead Drop and will be delivered when DC opens.
        const mediaLabel = msg.mediaType === 'audio' ? '🎤 Voice message' : '📷 Photo';
        try {
          const notifyMsg = {
            ...msg,
            text:      `${mediaLabel} (waiting for direct connection to deliver)`,
            mediaData: undefined,   // no payload — just the notification
            _pendingMedia: true,    // flag so receiver knows to expect delivery
          };
          const encryptedNotice = await this._encryptChat(relayEncryptPeerId, notifyMsg);
          await this.signaling.sendChat(relayTargetId, this._attachChatKeyHint(encryptedNotice));
        } catch {}
      } else {
        try {
          const encrypted = await this._encryptChat(relayEncryptPeerId, msg);
          await this.signaling.sendChat(relayTargetId, this._attachChatKeyHint(encrypted));
          console.log('[Mesh] Chat sent via Nostr relay to', routeLabel);
        } catch (nostrErr) {
          console.warn('[Mesh] Nostr chat failed, falling back to Dead Drop:', nostrErr.message);
          await this._storeDeadDrop(routePeerId || logicalTo, msg);
          this.onChat?.({ ...msg, direction: 'out', status: 'queued' });
          this._kickstartChatRoute(routePeerId || logicalTo);
        }
      }
    } else {
      // Last resort: Dead Drop
      await this._storeDeadDrop(routePeerId || logicalTo, msg);
      this.onChat?.({ ...msg, direction: 'out', status: 'queued' });
      this._kickstartChatRoute(routePeerId || logicalTo);
      console.log('[Mesh] Chat queued in Dead Drop for', routeLabel);
    }
    return msg;
  }

  async _handleChatMsg(fromPeerId, envelope) {
    // ── Nostr event-ID dedup ──────────────────────────────────────────────
    // The same Nostr event is delivered by every connected relay (up to 7×).
    // _nostrEventId is set on msg by nostr-signaling.js, then wrapped in
    // {payload: msg} by the onChat handler — check both locations.
    const _nostrId = envelope?._nostrEventId || envelope?.payload?._nostrEventId;
    if (_nostrId) {
      this._seenNostrIds = this._seenNostrIds || new Map();
      if (this._seenNostrIds.has(_nostrId)) return; // duplicate relay delivery
      this._seenNostrIds.set(_nostrId, Date.now());
      // GC: evict entries older than 60s
      if (this._seenNostrIds.size > 500) {
        const cutoff = Date.now() - 60000;
        for (const [id, ts] of this._seenNostrIds) {
          if (ts < cutoff) this._seenNostrIds.delete(id);
        }
      }
    }

    const payload = envelope?.payload || null;
    const payloadSig = payload?.encrypted
      ? `${payload.iv || ''}:${String(payload.ciphertext || '').slice(0, 64)}`
      : null;
    let msg;
    try {
      // envelope.payload can be:
      //   a) { iv, ciphertext, encrypted:true } — DataChannel AES-GCM
      //   b) plain msg object { id, from, to, text, ts, ... } — Nostr or plaintext DC
      if (payload?.ecdhPub) {
        await this._storeECDHPub(fromPeerId, payload.ecdhPub);
      }
      if (payload && typeof payload === 'object' && !payload.encrypted) {
        // Already a plain message (Nostr path or no-key DataChannel)
        msg = payload;
      } else {
        msg = await this._decryptChat(fromPeerId, payload);
      }
    } catch (err) {
      // Key not yet derived — queue message and retry when key arrives
      if (err.message && err.message.includes('No key')) {
        this._pendingChatSigs = this._pendingChatSigs || new Map();
        const peerSigSet = this._pendingChatSigs.get(fromPeerId) || new Set();
        if (payloadSig && peerSigSet.has(payloadSig)) return;
        if (payloadSig) {
          peerSigSet.add(payloadSig);
          if (peerSigSet.size > 300) peerSigSet.delete(peerSigSet.values().next().value);
          this._pendingChatSigs.set(fromPeerId, peerSigSet);
        }
        const q = this._pendingChat.get(fromPeerId) || [];
        q.push({ fromPeerId, envelope, payloadSig });
        if (q.length > 200) q.shift();
        this._pendingChat.set(fromPeerId, q);
        console.log('[Mesh] Chat queued (key pending) from', fromPeerId.slice(0,8));
        // Trigger ECDH re-exchange — our pub key may not have reached them
        this._kickstartChatRoute(fromPeerId);
        return;
      }
      // Stale/wrong shared key (peer reloaded, ECDH key rotated): re-key and retry.
      // Media can still flow because it doesn't use this AES payload path.
      if (envelope?.payload?.encrypted) {
        this._decryptFailCache = this._decryptFailCache || new Map();
        const failKey = `${fromPeerId}:${payloadSig || 'unknown'}`;
        const now = Date.now();
        const prevFail = this._decryptFailCache.get(failKey) || { count: 0, ts: now };
        const nextFail = (now - prevFail.ts > 30000)
          ? { count: 1, ts: now }
          : { count: prevFail.count + 1, ts: now };
        this._decryptFailCache.set(failKey, nextFail);
        if (nextFail.count > 3) {
          console.warn('[Mesh] Dropping undecryptable chat after retries from', fromPeerId.slice(0,8));
          return;
        }
        this.chatKeys.delete(fromPeerId);
        const q = this._pendingChat.get(fromPeerId) || [];
        const alreadyQueued = payloadSig && q.some((entry) => entry?.payloadSig === payloadSig);
        if (!alreadyQueued) {
          q.push({ fromPeerId, envelope, payloadSig });
          if (q.length > 200) q.shift();
        }
        this._pendingChat.set(fromPeerId, q);
        this._kickstartChatRoute(fromPeerId);
        console.warn('[Mesh] Chat decrypt failed, forcing re-key for', fromPeerId.slice(0,8));
        return;
      }
      if (err.message) {
        console.warn('[Mesh] Chat handling error:', fromPeerId.slice(0,8), err.message);
      }
      return;
    }
    if (!msg || (!msg.text && !msg.mediaType)) return; // allow media-only messages

    // ── Dedup before normalization ──────────────────────────────────────────────
    // Must run on the RAW msg.id (before we assign a uuid), so that every relay
    // delivery of the same message has the same id to key on.
    if (msg.id) {
      this._seenMsgIds = this._seenMsgIds || new Set();
      if (this._seenMsgIds.has(msg.id)) return; // already processing/processed
      this._seenMsgIds.add(msg.id);
      if (this._seenMsgIds.size > 500) {
        this._seenMsgIds.delete(this._seenMsgIds.values().next().value);
      }
    }

    // ── Rate-limit after decrypt+dedup: only counts genuine payloads ──────
    this._chatRateLimit = this._chatRateLimit || new Map();
    const senderKey = msg.senderUserId || msg.from || fromPeerId;
    const rl = this._chatRateLimit.get(senderKey) || { count: 0, reset: Date.now() + 5000 };
    if (Date.now() > rl.reset) { rl.count = 0; rl.reset = Date.now() + 5000; }
    rl.count++;
    this._chatRateLimit.set(senderKey, rl);
    if (rl.count > 30) {
      console.warn('[Mesh] Rate limited chat from', String(senderKey).slice(0,8));
      return;
    }

    // Normalise + sanitize required fields
    if (!msg.from) msg.from = this._resolveUserId(fromPeerId);
    if (!msg.to)   msg.to   = this.userId || this.peerId;
    if (!msg.senderUserId) msg.senderUserId = msg.from || this._resolveUserId(fromPeerId);
    if (!msg.recipientUserId) msg.recipientUserId = msg.to || (this.userId || this.peerId);
    this._bindPeerUser(fromPeerId, msg.senderUserId || msg.from);
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

    const chatTable = this._chatTable();
    // Also check DB to survive page reloads (in-memory Set clears on refresh)
    if (msg.id && chatTable) {
      const existing = await chatTable.where('id').equals(msg.id).first().catch(() => null);
      if (existing) return; // already stored
    }

    // Call signal piggyback: forward to UI call handler without storing in chat DB
    if (msg.type && msg.type.startsWith('call-')) {
      this.onChat?.({ ...msg, direction: 'in', _isCallSignal: true });
      return;
    }

    // Store and notify UI — strip transport-only flags but KEEP _pendingMedia
    // so receiver can identify messages awaiting DC delivery and request re-send.
    const { _nostrEventId: _neid, ...cleanMsg } = msg;
    await chatTable?.put?.({ ...cleanMsg, direction: 'in', read: false });
    this.onChat?.({ ...cleanMsg, direction: 'in' });
    const preview = String(msg.text || msg.mediaType || '').slice(0, 30);
    console.log('[Mesh] Chat received from', fromPeerId.slice(0,8), ':', preview);

    // Send read receipt (DataChannel only — Nostr doesn't need it)
    this._send(fromPeerId, { type: 'CHAT_READ', msgId: msg.id, ts: Date.now() });
  }

  _handleChatRead(fromPeerId, msg) {
    this._chatTable()?.where('id').equals(msg.msgId).modify({ read: true, readAt: msg.ts });
    this.onChat?.({ type: 'read', msgId: msg.msgId, from: this._resolveUserId(fromPeerId) });
  }

  // ─────────────────────────── Dead Drop 离线消息 ───────────────────────────

  async _storeDeadDrop(toPeerId, msg) {
    try {
      const toUserId = msg?.to || this._resolveUserId(toPeerId);
      const normalizedMsg = {
        ...msg,
        from: msg?.from || this.userId || this.peerId,
        to: msg?.to || toUserId || toPeerId,
        senderUserId: msg?.senderUserId || msg?.from || this.userId || this.peerId,
        recipientUserId: msg?.recipientUserId || msg?.to || toUserId || toPeerId,
      };
      await this.db?.deadDrop?.put({
        id:       this._uuid(),
        toPeerId,
        toUserId,
        msg: normalizedMsg,
        createdAt: Date.now(),
        delivered: false,
      });
    } catch (e) {
      console.warn('[Mesh] Dead Drop store failed:', e);
    }
  }

  async _deliverDeadDrop(peerId) {
    const directPending = await this.db?.deadDrop
      ?.where('toPeerId').equals(peerId)
      .filter(r => !r.delivered)
      .toArray() ?? [];
    const targetUserId = this._resolveUserId(peerId);
    const userPending = targetUserId
      ? await this.db?.deadDrop
        ?.toCollection()
        .filter(r => !r.delivered && r.toUserId === targetUserId)
        .toArray() ?? []
      : [];
    const pending = [...new Map([...directPending, ...userPending].map((r) => [r.id, r])).values()];

    for (const record of pending) {
      try {
        const msg = record.msg;
        let sent = false;

        // Media messages (image/audio): route through sendChatMedia (BLOB_STREAM)
        // to avoid the ~256KB DataChannel JSON limit that killed dead-drop delivery.
        if (msg.mediaData && typeof msg.mediaData === 'string' && msg.mediaData.startsWith('data:')) {
          const mime  = msg.mediaData.split(';')[0].split(':')[1] || 'image/jpeg';
          const b64   = msg.mediaData.split(',')[1] || '';
          const raw   = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const blob  = new Blob([raw], { type: mime });
          const result = await this.sendChatMedia(peerId, blob, {
            id: msg.id, from: msg.from, to: msg.to, ts: msg.ts,
            itemId: msg.itemId, mediaType: msg.mediaType, text: msg.text,
          });
          sent = result !== null;
        } else {
          // Text / call-signal: safe to send as JSON
          const payload = await this._encryptChat(peerId, msg);
          sent = this._send(peerId, { type: 'CHAT', payload });
        }

        if (sent) {
          await this.db.deadDrop.update(record.id, { delivered: true, deliveredAt: Date.now() });
          console.log('[Mesh] Dead Drop delivered to', peerId.slice(0,8),
            msg.mediaType ? `(${msg.mediaType})` : msg.text?.slice(0,20));
        }
      } catch (e) {
        console.warn('[Mesh] Dead Drop delivery error:', e.message);
      }
    }
  }


  /** Receiver-side: scan chatMessages for _pendingMedia from this peer, ask them to re-send. */
  async _requestPendingMedia(peerId) {
    const chatTable = this._chatTable();
    if (!chatTable) return;
    const dc = this.dataChannels.get(peerId);
    if (!dc || dc.readyState !== 'open') return;
    try {
      const userId = this._resolveUserId(peerId);
      const pending = await chatTable
        .filter(m => (m.from === peerId || m.from === userId) && m._pendingMedia === true && !m.mediaData)
        .toArray();
      if (!pending.length) return;
      const ids = pending.map(m => m.id).filter(Boolean);
      if (!ids.length) return;
      dc.send(JSON.stringify({ type: 'MEDIA_REREQUEST', ids }));
      console.log('[Mesh] Requested re-delivery of', ids.length, 'pending media from', peerId.slice(0,8));
    } catch(e) { /* non-fatal */ }
  }

  /** Sender-side: peer asked us to re-send media that arrived as "waiting" placeholder. */
  async _handleMediaRerequest(fromPeerId, msg) {
    if (!msg.ids?.length || !this.db?.deadDrop) return;
    const fromUserId = this._resolveUserId(fromPeerId);
    for (const msgId of msg.ids) {
      // Find the original message in Dead Drop (undelivered or re-deliver anyway)
      const directRecords = await this.db.deadDrop
        .where('toPeerId').equals(fromPeerId)
        .filter(r => r.msg?.id === msgId)
        .toArray().catch(() => []);
      const userRecords = await this.db.deadDrop
        .toCollection()
        .filter(r => r.toUserId === fromUserId && r.msg?.id === msgId)
        .toArray().catch(() => []);
      const records = [...new Map([...directRecords, ...userRecords].map((r) => [r.id, r])).values()];
      for (const record of records) {
        const m = record.msg;
        if (!m?.mediaData) continue;
        const mime = m.mediaData.split(';')[0].split(':')[1] || 'image/jpeg';
        const b64  = m.mediaData.split(',')[1] || '';
        try {
          const raw  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const blob = new Blob([raw], { type: mime });
          await this.sendChatMedia(fromPeerId, blob, {
            id: m.id, from: m.from, to: m.to, ts: m.ts,
            itemId: m.itemId, mediaType: m.mediaType, text: m.text,
          });
          console.log('[Mesh] Re-delivered media', msgId.slice(0,8), 'to', fromPeerId.slice(0,8));
          // Mark as delivered
          await this.db.deadDrop.update(record.id, { delivered: true, deliveredAt: Date.now() }).catch(() => {});
        } catch(e) {
          console.warn('[Mesh] Re-delivery failed for', msgId.slice(0,8), e.message);
        }
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
    const logicalTo = toPeerId;
    const routePeerId = this._resolvePeerTarget(toPeerId);
    const dc = routePeerId ? this.dataChannels.get(routePeerId) : null;
    if (!dc || dc.readyState !== 'open') {
      console.warn('[Mesh] sendChatMedia: no open DataChannel to', String(routePeerId || logicalTo).slice(0,8));
      return null;
    }

    // streamHash identifies this binary transfer; mediaHash identifies media content.
    const streamHash = meta?.id || this._uuid();
    const mediaHash = meta?.mediaHash || meta?.hash || null;
    const msg = {
      ...meta,
      id: streamHash,
      mediaHash: mediaHash || streamHash,
      from: meta?.from || this.userId || this.peerId,
      to: meta?.to || logicalTo,
      senderUserId: meta?.senderUserId || meta?.from || this.userId || this.peerId,
      recipientUserId: meta?.recipientUserId || meta?.to || logicalTo,
      senderSessionId: this.peerId,
      ts: meta.ts || Date.now(),
    };
    msg.hash = streamHash;

    // Store outgoing message locally + fire onChat so sender sees own bubble immediately.
    // DB stores base64 (survives refresh); optimistic bubble uses ObjectURL (fast).
    const objectUrl = URL.createObjectURL(blob);
    const outMsg    = { ...msg, mediaData: objectUrl, direction: 'out' };
    // Convert to base64 for persistent DB storage (ObjectURL dies on refresh)
    const reader = new FileReader();
    reader.onload = async () => {
      await this._chatTable()?.put?.({ ...msg, mediaData: reader.result, direction: 'out' }).catch(() => {});
    };
    reader.readAsDataURL(blob);
    this.onChat?.({ ...outMsg });

    try {
      const ab = await blob.arrayBuffer();
      // Announce meta so receiver knows this binary stream is a chat message
      dc.send(JSON.stringify({
        type: 'CHAT_MEDIA_META',
        ...msg,
        hash: streamHash,
        mediaHash: msg.mediaHash || streamHash,
        size: ab.byteLength,
      }));

      const mime  = blob.type || 'image/jpeg';
      const total = Math.ceil(ab.byteLength / OurBackyardMesh.CHUNK_SIZE);
      dc.send(JSON.stringify({
        type: 'BLOB_STREAM_START',
        hash: streamHash,
        mediaHash: msg.mediaHash || streamHash,
        mime,
        total,
        size: ab.byteLength,
        chatMsg: true,
      }));

      for (let i = 0; i < total; i++) {
        if (dc.bufferedAmount > OurBackyardMesh.MAX_BUFFER) {
          await new Promise(resolve => {
            const t = setTimeout(resolve, 200);
            dc.addEventListener('bufferedamountlow', function h() {
              clearTimeout(t); dc.removeEventListener('bufferedamountlow', h); resolve();
            }, { once: true });
          });
        }
        dc.send(ab.slice(i * OurBackyardMesh.CHUNK_SIZE, (i + 1) * OurBackyardMesh.CHUNK_SIZE));
      }
      dc.send(JSON.stringify({ type: 'BLOB_STREAM_END', hash: streamHash }));

      console.log('[Mesh] Chat media sent:', meta.mediaType, ab.byteLength, 'bytes to', String(routePeerId).slice(0,8));
      return msg;
    } catch (e) {
      console.warn('[Mesh] sendChatMedia error:', e.message);
      return null;
    }
  }

  /** Store incoming chat media meta so BLOB_STREAM_END can fire onChat */
  _handleChatMediaMeta(fromPeerId, msg) {
    const fromUserId = msg?.from || this._resolveUserId(fromPeerId);
    this._bindPeerUser(fromPeerId, msg?.senderUserId || fromUserId);
    const streamHash = msg?.hash || msg?.id;
    if (!streamHash) return;
    const mediaHash = msg?.mediaHash || msg?.hash || msg?.id || null;
    this._chatMediaPending = this._chatMediaPending || new Map();
    this._chatMediaPending.set(streamHash, {
      ...msg,
      hash: streamHash,
      mediaHash,
      from: fromUserId,
      senderUserId: msg?.senderUserId || fromUserId,
      recipientUserId: msg?.recipientUserId || msg?.to || this.userId || this.peerId,
      senderSessionId: fromPeerId,
    });
  }

  /**
   * BLOB_REQ handler — serialises all sends through a per-peer queue (mutex).
   *
   * Root cause of 80% corruption: multiple concurrent BLOB_REQ messages
   * (from sync + lazy-loader + re-requests) each called _handleBlobReq
   * concurrently, interleaving binary chunks from different blobs on the
   * same DataChannel.  The receiver's _routeBinaryChunk has no sequence
   * number and silently puts chunks in the wrong stream → corruption.
   *
   * Fix: every BLOB_REQ enqueues its hashes into a per-peer send queue.
   * A single drain loop runs exclusively — only one binary transfer at a
   * time per DataChannel, guaranteed no interleaving.
   */
  async _handleBlobReq(fromPeerId, msg) {
    if (!this.db || !msg.hashes?.length) return;
    const dc = this.dataChannels.get(fromPeerId);
    if (!dc || dc.readyState !== 'open') return;

    // ── Per-peer send queue (mutex) ──────────────────────────────────────
    this._blobSendQueues  = this._blobSendQueues  || new Map(); // peerId → hash[]
    this._blobSendRunning = this._blobSendRunning || new Set(); // peerId → draining?

    const queue = this._blobSendQueues.get(fromPeerId) || [];
    this._blobSendQueues.set(fromPeerId, queue);

    // De-dup: skip hashes already waiting or being sent
    const alreadyQueued = new Set(queue);
    const newHashes = msg.hashes
      .slice(0, OurBackyardMesh.BLOB_BATCH)
      .filter(h => h && !alreadyQueued.has(h));
    if (newHashes.length) queue.push(...newHashes);

    // If already draining for this peer, the running loop will pick up the new hashes
    if (this._blobSendRunning.has(fromPeerId)) return;

    // ── Drain loop — runs exclusively, one blob at a time ────────────────
    this._blobSendRunning.add(fromPeerId);
    try {
      while (queue.length > 0) {
        const dc2 = this.dataChannels.get(fromPeerId);
        if (!dc2 || dc2.readyState !== 'open') break;

        // Take next hash
        const hash = queue.shift();
        const rows = await this.db.blobs.where('hash').equals(hash).toArray();
        if (!rows.length) continue; // we don't have this blob, skip

        const b = rows[0];
        try {
          const ab  = await b.blob.arrayBuffer();
          const mime  = b.blob.type || 'image/jpeg';
          const total = Math.ceil(ab.byteLength / OurBackyardMesh.CHUNK_SIZE);

          // Header
          dc2.send(JSON.stringify({
            type: 'BLOB_STREAM_START',
            hash, mime, total, size: ab.byteLength, itemId: b.itemId,
          }));

          // Binary chunks — dedicated bufferedamountlow listener per drain loop
          for (let i = 0; i < total; i++) {
            if (!dc2 || dc2.readyState !== 'open') break;
            // Backpressure: wait until buffer drains before next chunk
            if (dc2.bufferedAmount > OurBackyardMesh.MAX_BUFFER) {
              await new Promise(resolve => {
                const timeout = setTimeout(resolve, 200);
                dc2.addEventListener('bufferedamountlow', function handler() {
                  clearTimeout(timeout);
                  dc2.removeEventListener('bufferedamountlow', handler);
                  resolve();
                }, { once: true });
              });
            }
            if (dc2.readyState !== 'open') break;
            dc2.send(ab.slice(i * OurBackyardMesh.CHUNK_SIZE, (i + 1) * OurBackyardMesh.CHUNK_SIZE));
          }

          // Footer
          if (dc2.readyState === 'open') {
            dc2.send(JSON.stringify({ type: 'BLOB_STREAM_END', hash }));
          }

          // Brief yield between blobs so other messages (chat, ping) can get through
          await new Promise(r => setTimeout(r, 10));
        } catch (e) {
          console.warn('[Mesh] BLOB send error for', hash?.slice(0,8), e.message);
        }
      }
    } finally {
      this._blobSendRunning.delete(fromPeerId);
      // If more hashes arrived while we were draining, restart
      const remaining = this._blobSendQueues.get(fromPeerId) || [];
      if (remaining.length > 0) {
        // Schedule a fresh drain rather than recursing
        setTimeout(() => this._handleBlobReq(fromPeerId, { hashes: remaining.splice(0) }), 0);
      }
    }
  }

  /** 收到 BLOB_STREAM_START — 初始化流式接收状态 */
  _handleBlobStreamStart(fromPeerId, msg) {
    if (!msg.hash) return;
    this._blobStreams = this._blobStreams || new Map();
    this._blobStreams.set(fromPeerId + ':' + msg.hash, {
      hash: msg.hash,
      mime: msg.mime || 'image/jpeg',
      itemId: msg.itemId,
      chatMsg: !!msg.chatMsg,   // preserve flag — skips strict header validation
      chunks: [], received: 0, total: msg.total,
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
      const blob = new Blob(state.chunks, { type: state.mime || 'image/jpeg' });

      // Integrity check: reject empty or suspiciously small blobs
      if (blob.size < 64) {
        console.warn('[Mesh] Blob too small, rejecting:', state.hash?.slice(0,8), blob.size);
        return;
      }
      // Verify chunk count matches expected total — reject partial blobs entirely
      if (state.total && state.chunks.length < state.total) {
        console.warn('[Mesh] Incomplete blob, discarding:', state.hash?.slice(0,8),
          state.chunks.length, '/', state.total, 'chunks — will re-request');
        // Schedule re-request from a different peer after short delay
        setTimeout(() => {
          if (this.db) {
            this.db.blobs.where('hash').equals(state.hash).count().then(n => {
              if (n === 0) this._requestBlobFromPeers(state.hash, state.itemId);
            }).catch(() => {});
          } else {
            this._requestBlobFromPeers(state.hash, state.itemId);
          }
        }, 1500);
        return; // do NOT save corrupted data
      }

      // ── Decode validation ──
      // Chat media (images, voice, camera) is trusted — skip heavy validation.
      // Only run header-byte check for marketplace blobs to catch corruption.
      let decodeOk = true;
      if (!state.chatMsg) {
        // For marketplace blobs, verify we have a known image format header
        try { await createImageBitmap(blob); }
        catch {
          const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
          const isJpeg = header[0] === 0xFF && header[1] === 0xD8;
          const isPng  = header[0] === 0x89 && header[1] === 0x50;
          const isGif  = header[0] === 0x47 && header[1] === 0x49;
          const isWebp = header[0] === 0x52 && header[1] === 0x49; // RIFF
          const isHeic = header[0] === 0x00 && header[1] === 0x00; // ftyp box
          decodeOk = isJpeg || isPng || isGif || isWebp || isHeic;
        }
      }
      if (!decodeOk) {
        console.warn('[Mesh] Blob has invalid header for', state.hash?.slice(0,8), '— discarding');
        setTimeout(() => this._requestBlobFromPeers(state.hash, state.itemId), 1500);
        return;
      }

      const existing = await this.db?.blobs.where('hash').equals(state.hash).first();
      if (!existing) {
        await this.db?.blobs.add({
          hash: state.hash, blob,
          itemId: state.itemId, timestamp: Date.now(),
          size: blob.size, mime: state.mime || 'image/jpeg',
        });
        console.log('[Mesh] Blob stored:', state.hash?.slice(0, 8), blob.size, 'bytes');
        if (this._blobRetries) this._blobRetries.delete(state.hash); // reset on success
      } else if (existing.size < blob.size) {
        // Replace smaller/older blob with this verified complete one
        await this.db?.blobs.put({
          ...existing, blob, size: blob.size, updatedAt: Date.now(),
        });
        console.log('[Mesh] Blob upgraded:', state.hash?.slice(0, 8), existing.size, '→', blob.size);
      }
      this._notifyBlobReady(state.hash);

      // Check if this blob was a chat media message
      const chatMeta = this._chatMediaPending?.get(state.hash);
      if (chatMeta) {
        this._chatMediaPending.delete(state.hash);
        const aliasHash = chatMeta.mediaHash;
        if (aliasHash && aliasHash !== state.hash) {
          const aliasExisting = await this.db?.blobs.where('hash').equals(aliasHash).first().catch(() => null);
          if (!aliasExisting) {
            await this.db?.blobs.add({
              hash: aliasHash, blob,
              itemId: state.itemId, timestamp: Date.now(),
              size: blob.size, mime: state.mime || 'image/jpeg',
            }).catch(() => {});
          } else if ((aliasExisting.size || 0) < blob.size) {
            await this.db?.blobs.put({
              ...aliasExisting, blob, size: blob.size, updatedAt: Date.now(),
            }).catch(() => {});
          }
          this._notifyBlobReady(aliasHash);
        }
        // Convert blob to dataUrl and fire onChat
        const reader = new FileReader();
        reader.onload = async () => {
          const chatTable = this._chatTable();
          const mediaMsg = {
            ...chatMeta,
            mediaHash: chatMeta.mediaHash || state.hash,
            mediaData: reader.result,
          };
          // Dedup: if the notify placeholder arrived before the real blob (dead drop scenario),
          // the record exists but has no mediaData — UPDATE it and refresh UI.
          const exists = await chatTable?.where('id').equals(mediaMsg.id).first().catch(() => null);
          if (!exists) {
            await chatTable?.put?.({ ...mediaMsg, direction: 'in', read: false });
            this.onChat?.({ ...mediaMsg, direction: 'in' });
          } else if (!exists.mediaData || exists.mediaData.length < mediaMsg.mediaData.length) {
            // Placeholder or lower-res exists — replace with full media and refresh bubble
            await chatTable?.put?.({ ...exists, ...mediaMsg, direction: 'in' });
            this.onChat?.({ ...mediaMsg, direction: 'in' });
          }
          // If this full-res upgrades a preview bubble (_upgradesId), update that bubble too
          if (chatMeta._upgradesId) {
            const preview = await chatTable?.where('id').equals(chatMeta._upgradesId).first().catch(() => null);
            if (preview) {
              const upgradedPreview = {
                ...preview,
                mediaType: preview.mediaType || chatMeta.mediaType || 'image',
                mediaHash: preview.mediaHash || chatMeta.mediaHash || state.hash,
                mediaData: reader.result,
                _upgraded: true,
              };
              await chatTable?.put?.(upgradedPreview).catch(() => {});
              this.onChat?.({ ...upgradedPreview, direction: 'in' });
            }
          }
        };
        reader.readAsDataURL(blob);
      }
    } catch (e) {
      console.warn('[Mesh] BLOB_STREAM_END error:', e.message);
    }
  }

  /** 触发图片 UI 更新（updateImageInUI 或 p2p-image-ready 事件） */
  // Request missing blobs from ALL connected peers (peer-disconnected recovery)
  _requestMissingBlobsFromAll(hashes) {
    if (!hashes || !hashes.length) return;
    const batches = [];
    for (let i = 0; i < hashes.length; i += OurBackyardMesh.BLOB_BATCH) {
      batches.push(hashes.slice(i, i + OurBackyardMesh.BLOB_BATCH));
    }
    let peerIdx = 0;
    const peers = Array.from(this.dataChannels.keys());
    if (!peers.length) return;
    batches.forEach((batch, i) => {
      // Round-robin across peers to spread load
      const pid = peers[peerIdx % peers.length];
      peerIdx++;
      setTimeout(() => this._send(pid, { type: 'BLOB_REQ', hashes: batch }), i * 500);
    });
    console.log(`[Mesh] Recovery BLOB_REQ: ${hashes.length} hashes across ${peers.length} peers`);
  }

  /** Re-request a blob from any connected peer that hasn't already served it */
  _requestBlobFromPeers(hash, itemId) {
    if (!hash) return;
    // ── Retry limit: max 4 attempts per hash to prevent infinite loop ──
    // A peer may always serve a corrupt blob (bad DB entry) — after 4 tries, give up.
    this._blobRetries = this._blobRetries || new Map();
    const retries = (this._blobRetries.get(hash) || 0) + 1;
    if (retries > 4) {
      console.warn('[Mesh] Giving up on blob after 4 retries:', hash?.slice(0,8));
      this._blobRetries.delete(hash); // clean up
      return;
    }
    this._blobRetries.set(hash, retries);

    const peers = [...this.dataChannels.entries()]
      .filter(([, dc]) => dc.readyState === 'open');
    if (peers.length === 0) {
      // No peers now — push to global queue for when next peer connects
      if (typeof window !== 'undefined' && Array.isArray(window.imageDownloadQueue)) {
        if (!window.imageDownloadQueue.some(t => t.hash === hash)) {
          window.imageDownloadQueue.push({ hash, sellerId: itemId || null });
        }
      }
      return;
    }
    // Pick a different peer each retry to avoid always hammering the same corrupt source
    const [pid, dc] = peers[retries % peers.length];
    try {
      dc.send(JSON.stringify({ type: 'BLOB_REQ', hashes: [hash] }));
      console.log('[Mesh] Re-requesting blob (attempt', retries, '):', hash?.slice(0,8), 'from', pid?.slice(0,8));
    } catch {}
  }

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
      const b64 = msg.data.replace(/[^A-Za-z0-9+/=]/g, '');
      const raw = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      const blob = new Blob([raw], { type: msg.mime || 'image/jpeg' });
      // Validate blob integrity before saving
      let _respDecodeOk = false;
      try { await createImageBitmap(blob); _respDecodeOk = true; } catch {
        const _h = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
        // Accept JPEG, PNG, GIF, WebP(RIFF), HEIC(ftyp), audio(EBML/OggS/MP3/MP4)
        _respDecodeOk = (_h[0]===0xFF&&_h[1]===0xD8) || (_h[0]===0x89&&_h[1]===0x50) ||
                        (_h[0]===0x47&&_h[1]===0x49) || (_h[0]===0x52&&_h[1]===0x49) ||
                        (_h[0]===0x00&&_h[1]===0x00) || // HEIC ftyp
                        (_h[0]===0x1A&&_h[1]===0x45) || // WebM/MKV (audio/video)
                        (_h[0]===0x4F&&_h[1]===0x67) || // OGG
                        (_h[0]===0xFF&&(_h[1]&0xE0)===0xE0); // MP3
      }
      if (!_respDecodeOk) {
        console.warn('[Mesh] BLOB_RESP corrupt, re-requesting:', msg.hash?.slice(0,8));
        setTimeout(() => this._requestBlobFromPeers(msg.hash, msg.itemId), 1500);
        return;
      }
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
      if (dc.bufferedAmount > OurBackyardMesh.MAX_BUFFER) {
        await new Promise(resolve => {
          const t = setTimeout(resolve, 200);
          dc.addEventListener('bufferedamountlow', function h() {
            clearTimeout(t); dc.removeEventListener('bufferedamountlow', h); resolve();
          }, { once: true });
        });
      }
      const chunk = ab.slice(i * OurBackyardMesh.CHUNK_SIZE, (i + 1) * OurBackyardMesh.CHUNK_SIZE);
      dc.send(chunk);
    }

    dc.send(JSON.stringify({ type: 'IMG_END', itemId }));
    return true;
  }




  // ─────────────────────────── 加密工具 ───────────────────────────

  async _deriveSharedKey(peerId, theirPublicKey, force = false) {
    if (!force && this.chatKeys.has(peerId)) return this.chatKeys.get(peerId);
    if (force) this.chatKeys.delete(peerId);
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
      this._pendingChatSigs?.delete?.(peerId);
      for (const { fromPeerId, envelope } of pending) {
        this._handleChatMsg(fromPeerId, envelope).catch(() => {});
      }
      // Flush any locally queued outbound messages as soon as the shared key exists.
      this._flushPendingChat(peerId).catch(() => {});
      return sharedKey;
    } catch {
      return null;
    }
  }

  async _storeECDHPub(peerId, hexPub) {
    try {
      const prevMeta = this.peerMeta.get(peerId) || {};
      const pubChanged = !!prevMeta.ecdhPub && prevMeta.ecdhPub !== hexPub;
      this.peerMeta.set(peerId, { ...prevMeta, ecdhPub: hexPub, lastSeen: Date.now() });
      const raw    = this._hex2ab(hexPub);
      const pubKey = await crypto.subtle.importKey(
        'raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      await this._deriveSharedKey(peerId, pubKey, pubChanged);
      if (this._decryptFailCache?.size) {
        for (const key of [...this._decryptFailCache.keys()]) {
          if (String(key).startsWith(peerId + ':')) this._decryptFailCache.delete(key);
        }
      }
      if (pubChanged) {
        console.log('[Mesh] ECDH key rotated for', peerId.slice(0,8), '- refreshed shared key');
      }
    } catch {}
  }

  _sendMyECDHPub(peerId) {
    const dc = this.dataChannels.get(peerId);
    if (!dc || dc.readyState !== 'open' || !this._myECDHPub) return false;
    try {
      dc.send(JSON.stringify({
        type: 'ECDH_PUB',
        from: this.peerId,
        ecdhPub: this._ab2hex(this._myECDHPub),
      }));
      return true;
    } catch {
      return false;
    }
  }

  _canRelayChatViaNostr(msg) {
    try {
      return JSON.stringify(msg || {}).length <= 24000;
    } catch {
      return false;
    }
  }

  _attachChatKeyHint(payload) {
    if (!payload || !this._myECDHPub) return payload;
    return {
      ...payload,
      ecdhPub: this._ab2hex(this._myECDHPub),
    };
  }

  _kickstartChatRoute(peerId) {
    const targetPeerId = this._resolvePeerTarget(peerId);
    if (!targetPeerId || targetPeerId === this.peerId) return;
    const hasSessionContext =
      this.peerMeta.has(targetPeerId) ||
      this.dataChannels.has(targetPeerId) ||
      this.peerConns.has(targetPeerId);

    this.signaling?.announce(
      this._myECDHPub ? { ecdhPub: this._ab2hex(this._myECDHPub) } : {}
    ).catch(() => {});
    if (!hasSessionContext) return;

    this._sendMyECDHPub(targetPeerId);

    if (!this.peerConns.has(targetPeerId)) {
      this._createOffer(targetPeerId).catch(err => {
        const msg = err?.message || '';
        if (!/stable|offer/i.test(msg)) {
          console.warn('[Mesh] Chat route kickstart failed for', targetPeerId.slice(0, 8), msg);
        }
      });
    }

    if (typeof window !== 'undefined' && typeof window.connectToPeer === 'function') {
      try { window.connectToPeer(this._resolveUserId(targetPeerId)); } catch {}
    }
  }

  async _flushPendingChat(peerId) {
    if (!peerId || !this.db?.deadDrop) return;

    const dc = this.dataChannels.get(peerId);
    if (dc?.readyState === 'open') {
      await this._deliverDeadDrop(peerId);
      return;
    }

    if (!this.signaling?.isOnline || !this.chatKeys.has(peerId)) return;

    const directPending = await this.db.deadDrop
      .where('toPeerId').equals(peerId)
      .filter(r => !r.delivered)
      .toArray().catch(() => []);
    const targetUserId = this._resolveUserId(peerId);
    const userPending = targetUserId
      ? await this.db.deadDrop
        .toCollection()
        .filter(r => !r.delivered && r.toUserId === targetUserId)
        .toArray().catch(() => [])
      : [];
    const pending = [...new Map([...directPending, ...userPending].map((r) => [r.id, r])).values()];

    for (const record of pending) {
      const msg = record?.msg;
      if (!msg || !this._canRelayChatViaNostr(msg)) continue;

      try {
        const payload = await this._encryptChat(peerId, msg);
        await this.signaling.sendChat(peerId, this._attachChatKeyHint(payload));
        await this.db.deadDrop.update(record.id, {
          delivered: true,
          deliveredAt: Date.now(),
          via: 'nostr',
        }).catch(() => {});
        console.log('[Mesh] Dead Drop delivered via Nostr to', peerId.slice(0, 8));
      } catch (e) {
        console.warn('[Mesh] Nostr dead-drop delivery error:', e?.message || e);
      }
    }
  }

  async _ensureChatKey(peerId) {
    const targetPeerId = this._resolvePeerTarget(peerId);
    if (!targetPeerId) return null;
    if (this.chatKeys.has(targetPeerId)) return this.chatKeys.get(targetPeerId);

    const meta = this.peerMeta.get(targetPeerId);
    if (meta?.ecdhPub) {
      await this._storeECDHPub(targetPeerId, meta.ecdhPub);
      if (this.chatKeys.has(targetPeerId)) return this.chatKeys.get(targetPeerId);
    }

    this._kickstartChatRoute(targetPeerId);
    return null;
  }

  _canonicalItemUpdate(msg) {
    const ownerUserId = msg.ownerUserId || msg.sellerId || null;
    return {
      type: 'ITEM_UPDATE',
      itemId: msg.itemId,
      status: msg.status,
      timestamp: msg.timestamp,
      updatedAt: msg.updatedAt,
      sellerId: msg.sellerId || ownerUserId,
      ownerUserId,
      title: msg.title,
      price: msg.price,
      description: msg.description,
      category: msg.category,
      imageHash: msg.imageHash || null,
      imageHashes: msg.imageHashes || [],
    };
  }

  async _encryptChat(toPeerId, msg) {
    const targetPeerId = this._resolvePeerTarget(toPeerId);
    const key = await this._ensureChatKey(targetPeerId || toPeerId);
    if (!key) throw new Error('No key for peer: ' + (targetPeerId || toPeerId));

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
    const logicalTarget = peerId;
    const targetPeerId = this._resolvePeerTarget(peerId) || peerId;
    const tryTargets = [targetPeerId];
    if (peerId && peerId !== targetPeerId) tryTargets.push(peerId);
    const cachedRoutePeerId = this._userRoutes?.get?.(logicalTarget)?.peerId;
    if (cachedRoutePeerId) tryTargets.push(cachedRoutePeerId);

    // Additional fallback: when target is a user id, try every known session route for that user.
    const targetUserId = this._resolveUserId(logicalTarget);
    for (const [sessionPeerId, meta] of this.peerMeta.entries()) {
      const mappedUserId = this._normalizeUserId(meta?.userId, meta?.peerId || sessionPeerId);
      if (mappedUserId === logicalTarget || (targetUserId && mappedUserId === targetUserId)) {
        tryTargets.push(sessionPeerId);
      }
    }

    if (this.dataChannels.size === 1) {
      const solePeerId = this.dataChannels.keys().next().value;
      if (solePeerId) tryTargets.push(solePeerId);
    }

    for (const candidate of [...new Set(tryTargets.filter(Boolean))]) {
      const dc = this.dataChannels.get(candidate);
      if (dc?.readyState !== 'open') continue;
      try {
        // Safety guard: strip any accidental mediaData before JSON serialization.
        // mediaData (base64 dataUrl) must ALWAYS go through sendChatMedia (BLOB_STREAM).
        // Sending it as JSON would produce a 200-400KB payload and crash the DataChannel.
        if (msg.mediaData) {
          console.warn('[Mesh] _send() blocked mediaData on', msg.type, '— use sendChatMedia() instead');
          const { mediaData, ...safe } = msg;
          dc.send(JSON.stringify(safe));
          return true;
        }
        const raw = JSON.stringify(msg);
        if (raw.length > 200000) {
          console.warn('[Mesh] _send() msg too large:', raw.length, 'bytes — type:', msg.type);
          return false;
        }
        dc.send(raw);
        return true;
      } catch {}
    }
    return false;
  }

  /**
   * Phase 3 — Register a publish-token verifier.
   * Called from OurBackyardBoot after PublishGuard is loaded.
   * @param {function} fn  async (token) => { ok, reason? }
   */
  setPublishVerifier(fn) {
    this._publishVerifier = fn;
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
    const targetPeerId = this._resolvePeerTarget(toPeerId) || toPeerId;
    // Serialize signal to plain JSON — RTCIceCandidate/RTCSessionDescription objects
    // cannot be cloned by BroadcastChannel.postMessage(), must be plain objects.
    const plainSignal = signal && typeof signal.toJSON === 'function'
      ? signal.toJSON()
      : JSON.parse(JSON.stringify(signal));

    // LAN BroadcastChannel (same browser, multiple tabs)
    if (this.lanChannel) {
      try {
        this.lanChannel.postMessage({ type: 'SIGNAL', from: this.peerId, target: targetPeerId, signal: plainSignal });
      } catch (e) {
        console.warn('[Mesh] BroadcastChannel postMessage failed:', e.message);
      }
    }
    // Nostr (cross-device)
    this.signaling?.sendSignal(targetPeerId, plainSignal).catch(() => {});
  }

  // ─────────────────────────── 心跳 ───────────────────────────

  _heartbeat() {
    const now = Date.now();
    this._pruneStalePeers(now);
    // 检查断线节点
    for (const [peerId, meta] of this.peerMeta) {
      if (now - meta.lastSeen > 60000 && !this.dataChannels.has(peerId)) {
        this.peerMeta.delete(peerId);
        this._unbindPeerRoute(peerId);
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

  get peerCount()   { return this._onlineUserCount(); }
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
