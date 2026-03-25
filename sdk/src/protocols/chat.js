import { uuid } from '../utils.js';

/**
 * ChatProtocol — P2P direct messaging plugin for P2PNode.
 *
 * Features:
 *  - Direct encrypted messages (or plaintext when no crypto)
 *  - Read receipts
 *  - Ephemeral typing indicators
 *  - Offline dead-drop via storage (messages stored until peer comes online)
 *  - Conversation history from storage
 *
 * Install as a plugin: `node.use(new ChatProtocol(node))`
 *
 * Message types handled: CHAT_MSG, CHAT_READ, CHAT_TYPING
 */
export class ChatProtocol {
  /**
   * @param {import('../p2p-node.js').P2PNode} p2pNode
   */
  constructor(p2pNode) {
    this._node    = p2pNode;
    this._storage = p2pNode._config?.storage || null;
    /** @type {Map<string, Function[]>} peerId → listeners */
    this._msgListeners    = new Map();
    this._typingListeners = new Map();
  }

  // ── Plugin interface ──────────────────────────────────────────────────────

  /**
   * Install the protocol into a P2PNode.
   * @param {import('../p2p-node.js').P2PNode} node
   */
  install(node) {
    this._node    = node;
    this._storage = node._config?.storage || null;

    node.router.handle('CHAT_MSG',    (from, msg) => this._onChatMsg(from, msg));
    node.router.handle('CHAT_READ',   (from, msg) => this._onChatRead(from, msg));
    node.router.handle('CHAT_TYPING', (from, msg) => this._onChatTyping(from, msg));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Send a message to a peer.
   * If the peer is offline, stores as a dead-drop for later delivery.
   * @param {string} toPeerId
   * @param {string} text
   * @param {string|null} [replyTo=null] - Message ID being replied to
   * @returns {Promise<object>} Created message
   */
  async sendMessage(toPeerId, text, replyTo = null) {
    if (!toPeerId) throw new TypeError('toPeerId is required');
    if (!text)     throw new TypeError('text is required');

    const msg = {
      id:        uuid(),
      type:      'CHAT_MSG',
      fromId:    this._node._config.peerId,
      toId:      toPeerId,
      text,
      replyTo:   replyTo || null,
      createdAt: Date.now(),
      readAt:    null,
    };

    // Store locally
    if (this._storage) {
      await this._storage.put(`chat:${msg.id}`, msg);
    }

    // Try direct send; fall back to dead-drop storage
    try {
      this._node.sendMessage(toPeerId, 'CHAT_MSG', msg);
    } catch {
      // Peer offline: store as dead-drop
      if (this._storage) {
        const deadDropKey = `deadDrop:${toPeerId}:${msg.id}`;
        await this._storage.put(deadDropKey, msg);
      }
    }

    return msg;
  }

  /**
   * Mark a message as read and send a read receipt.
   * @param {string} msgId
   * @returns {Promise<void>}
   */
  async markRead(msgId) {
    if (!msgId) throw new TypeError('msgId is required');
    const readAt = Date.now();

    if (this._storage) {
      const msg = await this._storage.get(`chat:${msgId}`);
      if (msg) {
        msg.readAt = readAt;
        await this._storage.put(`chat:${msgId}`, msg);
        // Notify sender
        try {
          this._node.sendMessage(msg.fromId, 'CHAT_READ', { type: 'CHAT_READ', id: uuid(), msgId, readAt });
        } catch {
          // ignore if peer offline
        }
      }
    }
  }

  /**
   * Send an ephemeral typing indicator to a peer.
   * @param {string} toPeerId
   */
  sendTyping(toPeerId) {
    if (!toPeerId) throw new TypeError('toPeerId is required');
    try {
      this._node.sendMessage(toPeerId, 'CHAT_TYPING', {
        type:   'CHAT_TYPING',
        id:     uuid(),
        fromId: this._node._config.peerId,
      });
    } catch {
      // ignore if peer offline
    }
  }

  /**
   * Get conversation messages with a peer, sorted by createdAt.
   * @param {string} peerId
   * @param {number} [limit=50]
   * @returns {Promise<object[]>}
   */
  async getConversation(peerId, limit = 50) {
    if (!peerId) throw new TypeError('peerId is required');
    if (!this._storage) return [];

    const myId = this._node._config.peerId;
    const all  = await this._storage.getAll();
    const msgs = all
      .filter(e => e.key.startsWith('chat:'))
      .map(e => e.value)
      .filter(msg =>
        msg &&
        ((msg.fromId === myId && msg.toId === peerId) ||
         (msg.fromId === peerId && msg.toId === myId))
      )
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    return msgs.slice(-limit);
  }

  /**
   * Get count of unread messages from a peer.
   * @param {string} peerId
   * @returns {Promise<number>}
   */
  async getUnreadCount(peerId) {
    if (!peerId) throw new TypeError('peerId is required');
    if (!this._storage) return 0;

    const myId = this._node._config.peerId;
    const all  = await this._storage.getAll();
    return all
      .filter(e => e.key.startsWith('chat:'))
      .map(e => e.value)
      .filter(msg =>
        msg &&
        msg.fromId === peerId &&
        msg.toId   === myId   &&
        !msg.readAt
      ).length;
  }

  /**
   * Deliver any pending dead-drop messages to a peer that has come online.
   * @param {string} peerId
   * @returns {Promise<number>} Number of messages delivered
   */
  async deliverPendingMessages(peerId) {
    if (!peerId || !this._storage) return 0;

    const all = await this._storage.getAll();
    const pending = all.filter(e => e.key.startsWith(`deadDrop:${peerId}:`));
    let delivered = 0;

    for (const entry of pending) {
      try {
        this._node.sendMessage(peerId, 'CHAT_MSG', entry.value);
        await this._storage.delete(entry.key);
        delivered++;
      } catch {
        // peer still offline
      }
    }
    return delivered;
  }

  /**
   * Subscribe to incoming messages from a specific peer.
   * @param {string} peerId
   * @param {Function} fn - (message) => void
   */
  onMessage(peerId, fn) {
    if (!this._msgListeners.has(peerId)) this._msgListeners.set(peerId, []);
    this._msgListeners.get(peerId).push(fn);
  }

  /**
   * Subscribe to typing indicators from a specific peer.
   * @param {string} peerId
   * @param {Function} fn - () => void
   */
  onTyping(peerId, fn) {
    if (!this._typingListeners.has(peerId)) this._typingListeners.set(peerId, []);
    this._typingListeners.get(peerId).push(fn);
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  /** @private */
  async _onChatMsg(from, msg) {
    if (!msg?.id) return;

    // Store incoming message
    if (this._storage) {
      const stored = { ...msg, receivedAt: Date.now() };
      await this._storage.put(`chat:${msg.id}`, stored);
    }

    // Notify listeners
    const listeners = this._msgListeners.get(from) || [];
    for (const fn of listeners) {
      try { fn(msg); } catch {}
    }
  }

  /** @private */
  async _onChatRead(from, msg) {
    if (!msg?.msgId || !this._storage) return;
    const stored = await this._storage.get(`chat:${msg.msgId}`);
    if (stored) {
      stored.readAt = msg.readAt || Date.now();
      await this._storage.put(`chat:${msg.msgId}`, stored);
    }
  }

  /** @private */
  _onChatTyping(from, msg) {
    const listeners = this._typingListeners.get(from) || [];
    for (const fn of listeners) {
      try { fn(); } catch {}
    }
  }
}
