/**
 * Chat View
 * OurBackyard P2P Marketplace
 * Handles peer-to-peer chat messaging
 */

const ChatView = {
    messages: [],
    currentPeer: null,
    
    /**
     * Initialize chat view
     */
    init() {
        // Listen for incoming chat messages
        window.addEventListener('p2p-chat', (event) => {
            this.handleIncomingMessage(event.detail);
        });
        
        // Bind send button
        const sendBtn = document.getElementById('btn-send-chat');
        if (sendBtn) {
            sendBtn.addEventListener('click', () => this.sendMessage());
        }
        
        // Bind enter key
        const input = document.getElementById('chat-input');
        if (input) {
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.sendMessage();
                }
            });
        }
        
        console.log("[ChatView] Initialized");
    },
    
    /**
     * Set current chat peer
     * @param {string} peerId
     * @param {string} displayName
     */
    setPeer(peerId, displayName) {
        this.currentPeer = { peerId, displayName };
        this.render();
    },
    
    /**
     * Handle incoming message
     * @param {Object} msg
     */
    handleIncomingMessage(msg) {
        if (msg.type !== 'CHAT_MESSAGE') return;
        
        this.messages.push({
            ...msg,
            incoming: true,
            timestamp: msg.timestamp || Date.now(),
        });
        
        this.render();
        this.scrollToBottom();
    },
    
    /**
     * Send message
     */
    sendMessage() {
        const input = document.getElementById('chat-input');
        if (!input || !input.value.trim()) return;
        
        const message = input.value.trim();
        input.value = '';
        
        const msg = {
            type: 'CHAT_MESSAGE',
            fromPeerId: window.peerId,
            fromName: window.displayName,
            toPeerId: this.currentPeer?.peerId,
            message,
            timestamp: Date.now(),
        };
        
        // Add to local messages
        this.messages.push({
            ...msg,
            incoming: false,
        });
        
        // Send via P2P
        if (window.P2PStreamer?.broadcast) {
            window.P2PStreamer.broadcast(msg);
        }
        
        // Also send via WebSocket
        if (window.ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
        
        this.render();
        this.scrollToBottom();
    },
    
    /**
     * Render chat messages
     */
    render() {
        const container = document.getElementById('chat-messages');
        if (!container) return;
        
        if (this.messages.length === 0) {
            container.innerHTML = `
                <div class="chat-empty">
                    <div class="empty-icon">💬</div>
                    <div class="empty-text">開始對話吧！</div>
                </div>
            `;
            return;
        }
        
        const html = this.messages.map(msg => {
            const isOwn = msg.fromPeerId === window.peerId;
            const time = new Date(msg.timestamp).toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            
            return `
                <div class="chat-message ${isOwn ? 'outgoing' : 'incoming'}">
                    <div class="chat-bubble">
                        ${this.escapeHtml(msg.message)}
                    </div>
                    <div class="chat-meta">
                        ${!isOwn ? `<span class="chat-name">${this.escapeHtml(msg.fromName || 'Unknown')}</span>` : ''}
                        <span class="chat-time">${time}</span>
                    </div>
                </div>
            `;
        }).join('');
        
        container.innerHTML = html;
    },
    
    /**
     * Scroll to bottom of chat
     */
    scrollToBottom() {
        const container = document.getElementById('chat-messages');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    },
    
    /**
     * Escape HTML to prevent XSS
     * @param {string} text
     * @returns {string}
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
    
    /**
     * Clear chat
     */
    clear() {
        this.messages = [];
        this.currentPeer = null;
        this.render();
    },
};

// Export
window.ChatView = ChatView;
