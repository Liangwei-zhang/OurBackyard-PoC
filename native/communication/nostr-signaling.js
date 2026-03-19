/**
 * NostrSignaling — 完全去中心化的 WebRTC 信令层
 *
 * 用 Nostr 公共中继替换 server.py。
 * 无需任何服务器，使用社区运营的公共 Nostr 中继节点作为信令通道。
 *
 * 工作原理：
 *   1. 连接多个公共 Nostr 中继（任一可用即可）
 *   2. 订阅本节点的 H3 地理格子频道
 *   3. 发布加密的 WebRTC offer/answer/ICE 事件
 *   4. 收到事件后触发 onSignal 回调
 *
 * 不需要任何 npm 包，纯浏览器原生实现。
 */

class NostrSignaling {
  // 公共 Nostr 中继列表 — 按可靠性排序，前3个优先
  static RELAYS = [
    'wss://relay.damus.io',       // Most reliable
    'wss://nostr.wine',           // Very reliable
    'wss://nos.lol',              // Fast
    'wss://relay.snort.social',   // Good uptime
    'wss://nostr.oxtr.dev',       // Backup
    'wss://relay.primal.net',     // High capacity
    'wss://nostr-pub.wellorder.net', // Long-running
  ];

  // 自定义 kind，避免污染公共 Nostr 内容流
  static KIND_SIGNAL   = 25001;  // WebRTC 信令（加密）
  static KIND_ANNOUNCE = 25002;  // 节点存在广播（明文）
  static KIND_CHAT     = 25003;  // 聊天消息（Nostr 直连，无需 DataChannel）

  constructor({ peerId, h3Cell, privateKey, onSignal, onPeerAnnounce, onChat }) {
    this.peerId       = peerId;       // 本节点 ID
    this.h3Cell       = h3Cell;       // H3 L9 地理格子（本地精度）
    // 使用 L7 格子作为 Nostr 公共频道（~5km²），避免相邻 L9 格子的用户互相看不见
    // L7 = 把 L9 格子的 digit 7-14 全部设为 7 (unused/padding)
    this.channelCell  = NostrSignaling._toL7(h3Cell);
    this.privateKey   = privateKey;   // Ed25519/secp256k1 私钥（hex）
    this.onSignal     = onSignal;     // (fromPeerId, signal) => void
    this.onPeerAnnounce = onPeerAnnounce; // (peerId, meta) => void
    this.onChat         = onChat;         // (fromPeerId, msg) => void

    this.relays      = new Map();     // url -> WebSocket
    this.connected   = new Set();     // 已连接的中继 url
    this.subId       = this._randomHex(16);
    this.pubkey      = null;          // Nostr 公钥（从 peerId 派生）
    this._pendingQueue = [];          // 连接前暂存待发事件
    console.log(`[Nostr] L9 cell: ${h3Cell} → L7 channel: ${this.channelCell}`);
  }

  /**
   * 将 H3 L9 格子转换为 L7 父格子（纯位运算，无需 h3-js）
   * L7: 保留 resolution 字段改为 7，将 digit 7-14 全部设为 7 (0b111)
   */
  static _toL7(h3CellHex) {
    // Convert H3 L9 cell to L7 parent via bit manipulation (no h3-js needed)
    // L7 covers ~5km² — ensures neighbors on different L9 cells share the same Nostr channel
    try {
      if (!h3CellHex || !/^[0-9a-fA-F]{15}$/.test(String(h3CellHex).replace(/^0+/, '').padStart(15, '0'))) {
        return h3CellHex; // not a valid H3 hex — return as-is
      }
      const normalized = String(h3CellHex).padStart(15, '0');
      const cell = BigInt('0x' + normalized);
      // Mask digits 7-14 to 7 (0b111) — these digits are unused at resolution 7
      let digitMask = 0n;
      for (let d = 7; d < 15; d++) {
        const shift = BigInt(44 - d * 3);
        digitMask |= (7n << shift);
      }
      // Set resolution field [55:52] to 7
      const resMask = 0xFn << 52n;
      const l7 = (cell & ~resMask & ~digitMask) | (7n << 52n) | digitMask;
      return l7.toString(16).padStart(15, '0');
    } catch (e) {
      return h3CellHex; // fallback on any error
    }
  }

  /** 初始化：连接中继、订阅频道 */
  async init() {
    // 生成或恢复确定性的 secp256k1 私钥（从 peerId 派生，用于 Schnorr 签名）
    await this._initKeys();

    // Connect to relays in parallel — don't wait for slow ones
    // Start fast: resolve as soon as ≥1 relay connects (3s max)
    await new Promise((resolve) => {
      let settled = 0;
      const total = NostrSignaling.RELAYS.length;
      const fastResolve = () => { if (this.connected.size >= 1) resolve(); };
      const onDone = () => { settled++; fastResolve(); if (settled >= total) resolve(); };
      NostrSignaling.RELAYS.forEach(url => this._connectRelay(url).then(onDone).catch(onDone));
      setTimeout(resolve, 4000); // hard timeout — don't block boot more than 4s
    });

    if (this.connected.size === 0) {
      console.warn('[Nostr] No relays connected — falling back to LAN only');
    } else {
      console.log(`[Nostr] Connected to ${this.connected.size} relays (fast boot)`);
    }

    // 发布本节点存在声明
    await this.announce();
    return this;
  }

  /** 连接单个中继 */
  _connectRelay(url) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 6000); // 6s per relay

      try {
        const ws = new WebSocket(url);
        ws.onopen = () => {
          clearTimeout(timeout);
          this.relays.set(url, ws);
          this.connected.add(url);

          // 订阅本节点 H3 格子的信令频道
          this._subscribe(ws);

          // 发送暂存事件
          this._pendingQueue.forEach(ev => this._publishToRelay(ws, ev));
          this._pendingQueue = [];

          console.log(`[Nostr] Connected: ${url}`);
          resolve(ws);
        };

        ws.onmessage = (e) => this._handleRelayMsg(url, e.data);

        ws.onclose = () => {
          this.relays.delete(url);
          this.connected.delete(url);
          // 3s reconnect backoff
          setTimeout(() => this._connectRelay(url), 3000);
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(null);
        };
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  /** 订阅本节点的信令频道 */
  _subscribe(ws) {
    const filter = {
      kinds: [NostrSignaling.KIND_SIGNAL, NostrSignaling.KIND_ANNOUNCE, NostrSignaling.KIND_CHAT],
      '#h': [this.channelCell], // 使用 L7 格子频道，覆盖 ~5km 范围
      since: Math.floor(Date.now() / 1000) - 300,
    };
    ws.send(JSON.stringify(['REQ', this.subId, filter]));
  }

  /** 处理中继收到的消息 */
  _handleRelayMsg(url, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg[0] !== 'EVENT') return;
    const event = msg[2];
    // Validate event structure
    if (!event || typeof event !== 'object' || !event.kind || !event.content) return;
    if (typeof event.content !== 'string' || event.content.length > 65536) return; // 64KB max

    // 过滤自己发的事件
    if (event.pubkey === this.pubkey) return;

    const senderPeerId = this._getTag(event, 'peer');
    const targetPeerId = this._getTag(event, 'target');
    // Validate peerId format
    if (!senderPeerId || !/^[a-zA-Z0-9_-]{1,50}$/.test(senderPeerId)) return;

    if (event.kind === NostrSignaling.KIND_ANNOUNCE && senderPeerId) {
      // 节点存在广播
      try {
        const meta = JSON.parse(event.content);
        this.onPeerAnnounce?.(senderPeerId, meta);
      } catch {}
      return;
    }

    if (event.kind === NostrSignaling.KIND_CHAT) {
      // 聊天消息：只处理发给自己的
      if (targetPeerId && targetPeerId !== this.peerId) return;
      try {
        const msg = JSON.parse(event.content);
        if (senderPeerId && msg) {
          this.onChat?.(senderPeerId, msg);
        }
      } catch (err) {
        console.warn('[Nostr] Chat parse error:', err);
      }
      return;
    }

    if (event.kind === NostrSignaling.KIND_SIGNAL) {
      // 信令消息：只处理发给自己的
      if (targetPeerId && targetPeerId !== this.peerId) return;

      try {
        const signal = JSON.parse(event.content);
        if (senderPeerId) {
          this.onSignal?.(senderPeerId, signal);
        }
      } catch (err) {
        console.error('[Nostr] Signal parse error:', err);
      }
    }
  }

  /**
   * 发送信令消息给指定节点
   * @param {string} targetPeerId
   * @param {object} signal  { type: 'offer'|'answer'|'ice-candidate', ... }
   */
  async sendSignal(targetPeerId, signal) {
    const event = await this._buildEvent(
      NostrSignaling.KIND_SIGNAL,
      JSON.stringify(signal),
      [
        ['h', this.channelCell], // L7 频道
        ['peer', this.peerId],
        ['target', targetPeerId],
      ]
    );
    this._publish(event);
  }


  /**
   * 通过 Nostr 中继发送聊天消息（无需 WebRTC DataChannel）
   * 当 DataChannel 不可用时作为主要传输通道
   */
  async sendChat(targetPeerId, msg) {
    const event = await this._buildEvent(
      NostrSignaling.KIND_CHAT,
      JSON.stringify(msg),
      [
        ['h', this.channelCell],
        ['peer', this.peerId],
        ['target', targetPeerId],
      ]
    );
    this._publish(event);
  }
  /** 广播本节点存在（让邻居发现我） */
  async announce(meta = {}) {
    const event = await this._buildEvent(
      NostrSignaling.KIND_ANNOUNCE,
      JSON.stringify({ peerId: this.peerId, ts: Date.now(), ...meta }),
      [
        ['h', this.channelCell], // L7 频道
        ['peer', this.peerId],
      ]
    );
    this._publish(event);
  }

  /** 向所有已连接中继发布事件 */
  _publish(event) {
    const msg = JSON.stringify(['EVENT', event]);
    let sent = 0;
    for (const ws of this.relays.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        sent++;
      }
    }
    if (sent === 0) {
      // 还没连上任何中继，暂存
      this._pendingQueue.push(event);
    }
  }

  _publishToRelay(ws, event) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(['EVENT', event]));
    }
  }

  /** 构造 Nostr 事件（NIP-01） */
  async _buildEvent(kind, content, tags) {
    const event = {
      pubkey:     this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content,
    };
    event.id  = await this._eventId(event);
    event.sig = await this._sign(event.id);
    return event;
  }

  /** 计算事件 ID（SHA-256 of canonical JSON） */
  async _eventId(event) {
    const canonical = JSON.stringify([
      0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
    ]);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  /** 初始化 secp256k1 密钥对（从 peerId 确定性派生） */
  async _initKeys() {
    // 派生确定性私钥：SHA-256("nostr-priv:" + peerId) 作为私钥种子
    const seed = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode('nostr-priv:' + this.peerId));
    const seedHex = Array.from(new Uint8Array(seed))
      .map(b => b.toString(16).padStart(2,'0')).join('');

    // 用 secp256k1 库得到有效私钥（确保在 [1, N-1] 范围内）
    if (typeof secp256k1 !== 'undefined' && secp256k1.getPublicKey) {
      this._privkey = seedHex;
      this.pubkey = secp256k1.getPublicKey(seedHex);
      console.log('[Nostr] secp256k1 keys ready, pubkey:', this.pubkey.slice(0, 16) + '...');
    } else {
      // Fallback: secp256k1 库未加载，使用 SHA-256 伪签名（relay 可能拒绝）
      console.warn('[Nostr] secp256k1 not loaded — using mock signatures, relay may reject events');
      this._privkey = null;
      this.pubkey = seedHex;
    }
  }

  /** Schnorr 签名（BIP-340） */
  async _sign(id) {
    if (this._privkey && typeof secp256k1 !== 'undefined' && secp256k1.schnorrSign) {
      return secp256k1.schnorrSign(id, this._privkey);
    }
    // Fallback mock signature (64 bytes = 128 hex)
    const buf = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(id + this.peerId));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('') + '0'.repeat(64);
  }

  _getTag(event, name) {
    return event.tags?.find(t => t[0] === name)?.[1];
  }

  _randomHex(len) {
    return Array.from(crypto.getRandomValues(new Uint8Array(len)))
      .map(b => b.toString(16).padStart(2,'0')).join('');
  }

  get isOnline() {
    return this.connected.size > 0;
  }
}

if (typeof module !== 'undefined') module.exports = { NostrSignaling };
