import { P2PNode } from '../p2p-node.js';

export interface ChatMessage {
  id: string;
  fromPeerId: string;
  toPeerId: string;
  text: string;
  sentAt: number;
  readAt?: number;
}

/**
 * ChatProtocol — P2P direct messaging plugin.
 *
 * Install via: `node.use(new ChatProtocol(node))`
 *
 * Message types: CHAT_MSG, CHAT_READ, CHAT_TYPING
 */
export declare class ChatProtocol {
  constructor(p2pNode: P2PNode);

  /** Called automatically by P2PNode.use(). */
  install(node: P2PNode): void;

  /**
   * Send a direct message to a peer.
   * If the peer is offline, stores as a dead-drop for later delivery.
   */
  sendMessage(toPeerId: string, text: string): Promise<ChatMessage>;

  /** Mark all messages from a peer as read. */
  markRead(fromPeerId: string): Promise<void>;

  /** Send an ephemeral typing indicator. */
  sendTyping(toPeerId: string): void;

  /** Return conversation history with a peer (from storage). */
  getHistory(peerId: string): Promise<ChatMessage[]>;

  /** Listen for incoming messages from a specific peer. */
  onMessage(fromPeerId: string, fn: (msg: ChatMessage) => void): void;

  /** Listen for typing indicators from a specific peer. */
  onTyping(fromPeerId: string, fn: () => void): void;
}
