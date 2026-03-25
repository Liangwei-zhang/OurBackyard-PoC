/**
 * Tests for ChatProtocol.
 * Run with: node --test sdk/tests/chat.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { ChatProtocol } from '../src/protocols/chat.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeNode(peerId = 'alice', storage = null) {
  const _handlers = new Map();
  const _sent     = [];
  const _storage  = storage || new MemoryStorage();

  const router = {
    handle(type, fn) { _handlers.set(type, fn); },
    _trigger(type, from, msg) { const h = _handlers.get(type); if (h) return h(from, msg); },
  };

  return {
    _config:    { peerId, storage: _storage },
    router,
    storage:    _storage,
    _sent,
    sendMessage(toPeerId, type, payload) { _sent.push({ toPeerId, type, payload }); },
    broadcastMessage() {},
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ChatProtocol — sendMessage', () => {
  it('should send a message to a peer', async () => {
    const node  = makeNode('alice');
    const chat  = new ChatProtocol(node);
    chat.install(node);

    const msg = await chat.sendMessage('bob', 'Hello!');
    assert.ok(msg.id);
    assert.equal(msg.fromId, 'alice');
    assert.equal(msg.toId, 'bob');
    assert.equal(msg.text, 'Hello!');
    assert.equal(msg.readAt, null);
  });

  it('should store message in storage', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    const msg = await chat.sendMessage('bob', 'Hi!');
    const stored = await node.storage.get(`chat:${msg.id}`);
    assert.ok(stored);
    assert.equal(stored.text, 'Hi!');
  });

  it('should send with replyTo', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    const msg = await chat.sendMessage('bob', 'Reply!', 'orig-id');
    assert.equal(msg.replyTo, 'orig-id');
  });

  it('should throw if toPeerId is missing', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);
    await assert.rejects(() => chat.sendMessage(null, 'Hi'), /toPeerId is required/);
  });

  it('should throw if text is missing', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);
    await assert.rejects(() => chat.sendMessage('bob', ''), /text is required/);
  });
});

describe('ChatProtocol — receive message', () => {
  it('should store received message via CHAT_MSG handler', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    const incomingMsg = { id: 'msg-1', type: 'CHAT_MSG', fromId: 'bob', toId: 'alice', text: 'Hey!', createdAt: Date.now() };
    await node.router._trigger('CHAT_MSG', 'bob', incomingMsg);

    const stored = await node.storage.get('chat:msg-1');
    assert.ok(stored);
    assert.equal(stored.text, 'Hey!');
  });

  it('should notify onMessage listener', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    let received = null;
    chat.onMessage('bob', (msg) => { received = msg; });

    const incomingMsg = { id: 'msg-2', type: 'CHAT_MSG', fromId: 'bob', toId: 'alice', text: 'Howdy', createdAt: Date.now() };
    await node.router._trigger('CHAT_MSG', 'bob', incomingMsg);
    assert.ok(received);
    assert.equal(received.text, 'Howdy');
  });
});

describe('ChatProtocol — markRead', () => {
  it('should update readAt on the stored message', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    // Store a message from bob
    const incomingMsg = { id: 'msg-3', type: 'CHAT_MSG', fromId: 'bob', toId: 'alice', text: 'Read me', createdAt: Date.now() };
    await node.router._trigger('CHAT_MSG', 'bob', incomingMsg);

    await chat.markRead('msg-3');
    const stored = await node.storage.get('chat:msg-3');
    assert.ok(stored.readAt);
    assert.ok(stored.readAt > 0);
  });

  it('should throw if msgId is missing', async () => {
    const node = makeNode();
    const chat = new ChatProtocol(node);
    chat.install(node);
    await assert.rejects(() => chat.markRead(null), /msgId is required/);
  });
});

describe('ChatProtocol — typing indicator', () => {
  it('should send CHAT_TYPING message', () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);
    chat.sendTyping('bob');
    assert.equal(node._sent.length, 1);
    assert.equal(node._sent[0].type, 'CHAT_TYPING');
    assert.equal(node._sent[0].toPeerId, 'bob');
  });

  it('should notify onTyping listener', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    let typingReceived = false;
    chat.onTyping('bob', () => { typingReceived = true; });
    node.router._trigger('CHAT_TYPING', 'bob', { type: 'CHAT_TYPING', fromId: 'bob' });
    assert.ok(typingReceived);
  });

  it('should throw if toPeerId is missing', () => {
    const node = makeNode();
    const chat = new ChatProtocol(node);
    chat.install(node);
    assert.throws(() => chat.sendTyping(null), /toPeerId is required/);
  });
});

describe('ChatProtocol — getConversation', () => {
  it('should return messages between two peers sorted by createdAt', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    await chat.sendMessage('bob', 'First');
    await chat.sendMessage('bob', 'Second');
    // Simulate incoming message
    await node.router._trigger('CHAT_MSG', 'bob', {
      id: 'bob-msg-1', type: 'CHAT_MSG', fromId: 'bob', toId: 'alice', text: 'Reply', createdAt: Date.now()
    });

    const convo = await chat.getConversation('bob');
    assert.ok(convo.length >= 2);
    // All messages should be from/to bob/alice
    for (const msg of convo) {
      assert.ok(
        (msg.fromId === 'alice' && msg.toId === 'bob') ||
        (msg.fromId === 'bob'   && msg.toId === 'alice')
      );
    }
  });

  it('should not include messages from other peers', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    await chat.sendMessage('bob', 'To bob');
    await node.router._trigger('CHAT_MSG', 'charlie', {
      id: 'charlie-1', type: 'CHAT_MSG', fromId: 'charlie', toId: 'alice', text: 'Hi from charlie', createdAt: Date.now()
    });

    const convo = await chat.getConversation('bob');
    for (const msg of convo) {
      assert.ok(msg.fromId !== 'charlie');
    }
  });
});

describe('ChatProtocol — getUnreadCount', () => {
  it('should count unread messages from a peer', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    await node.router._trigger('CHAT_MSG', 'bob', {
      id: 'unread-1', type: 'CHAT_MSG', fromId: 'bob', toId: 'alice', text: 'Msg 1', createdAt: Date.now()
    });
    await node.router._trigger('CHAT_MSG', 'bob', {
      id: 'unread-2', type: 'CHAT_MSG', fromId: 'bob', toId: 'alice', text: 'Msg 2', createdAt: Date.now()
    });

    const count = await chat.getUnreadCount('bob');
    assert.equal(count, 2);
  });

  it('should return 0 after marking messages read', async () => {
    const node = makeNode('alice');
    const chat = new ChatProtocol(node);
    chat.install(node);

    await node.router._trigger('CHAT_MSG', 'bob', {
      id: 'read-msg-1', type: 'CHAT_MSG', fromId: 'bob', toId: 'alice', text: 'Hi', createdAt: Date.now()
    });

    await chat.markRead('read-msg-1');
    const count = await chat.getUnreadCount('bob');
    assert.equal(count, 0);
  });
});

describe('ChatProtocol — offline dead-drop', () => {
  it('should store message as dead-drop if send throws', async () => {
    const node = makeNode('alice');
    node.sendMessage = () => { throw new Error('peer offline'); };

    const chat = new ChatProtocol(node);
    chat.install(node);

    await chat.sendMessage('bob', 'offline msg');

    const all = await node.storage.getAll();
    const deadDrops = all.filter(e => e.key.startsWith('deadDrop:bob:'));
    assert.equal(deadDrops.length, 1);
    assert.equal(deadDrops[0].value.text, 'offline msg');
  });
});
