/**
 * P2P Streamer Service
 * OurBackyard P2P Marketplace
 * Handles WebRTC data channels for peer-to-peer communication
 */

const P2PStreamer = {
    peerConnections: new Map(), // peerId -> RTCPeerConnection
    dataChannels: new Map(),   // peerId -> RTCDataChannel
    
    /**
     * Initialize P2P connections
     */
    init() {
        console.log("[P2P] Initialized");
    },

    /**
     * Get all connected peers
     * @returns {string[]} Array of peer IDs
     */
    getPeers() {
        return Array.from(this.peerConnections.keys());
    },

    /**
     * Create a peer connection
     * @param {string} peerId - Target peer ID
     * @returns {RTCPeerConnection}
     */
    async createConnection(peerId) {
        const config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]
        };

        const pc = new RTCPeerConnection(config);
        this.peerConnections.set(peerId, pc);

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignal(peerId, {
                    type: "ice-candidate",
                    candidate: event.candidate,
                });
            }
        };

        // Handle connection state
        pc.onconnectionstatechange = () => {
            console.log(`[P2P] ${peerId} connection state:`, pc.connectionState);
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                this.removePeer(peerId);
            }
        };

        // Create data channel
        const dc = pc.createDataChannel("data", {
            ordered: true,
        });
        
        this.setupDataChannel(dc, peerId);
        
        // Handle incoming data channels
        pc.ondatachannel = (event) => {
            this.setupDataChannel(event.channel, peerId);
        };

        return pc;
    },

    /**
     * Setup data channel event handlers
     * @param {RTCDataChannel} dc
     * @param {string} peerId
     */
    setupDataChannel(dc, peerId) {
        dc.onopen = () => {
            console.log(`[P2P] Data channel open with ${peerId}`);
            this.dataChannels.set(peerId, dc);
        };

        dc.onclose = () => {
            console.log(`[P2P] Data channel closed with ${peerId}`);
            this.dataChannels.delete(peerId);
        };

        dc.onmessage = (event) => {
            this.handleMessage(peerId, event.data);
        };

        dc.onerror = (err) => {
            console.error(`[P2P] Data channel error with ${peerId}:`, err);
        };
    },

    /**
     * Handle incoming P2P message
     * @param {string} peerId
     * @param {Object} data
     */
    handleMessage(peerId, data) {
        try {
            const msg = JSON.parse(data);
            console.log(`[P2P] Message from ${peerId}:`, msg.type);
            
            // Handle different message types
            switch (msg.type) {
                case "NEW_ITEM":
                    this.handleNewItem(msg);
                    break;
                case "ITEM_UPDATE":
                    this.handleItemUpdate(msg);
                    break;
                case "CHAT_MESSAGE":
                    this.handleChatMessage(msg);
                    break;
                default:
                    console.log(`[P2P] Unknown message type: ${msg.type}`);
            }
        } catch (err) {
            console.error("[P2P] Message parse error:", err);
        }
    },

    /**
     * Handle new item message
     * @param {Object} msg
     */
    async handleNewItem(msg) {
        const db = window.db;
        if (!db) return;
        
        // Check if already exists
        const existing = await db.items.where("itemId").equals(msg.itemId).first();
        if (existing) return;
        
        // Save to local DB
        await db.items.put({
            ...msg,
            syncedAt: Date.now(),
        });
        
        // Refresh UI
        if (window.loadItems) {
            window.loadItems();
        }
    },

    /**
     * Handle item update message
     * @param {Object} msg
     */
    async handleItemUpdate(msg) {
        const db = window.db;
        if (!db) return;
        
        const item = await db.items.where("itemId").equals(msg.itemId).first();
        if (item) {
            await db.items.update(item.id, {
                status: msg.status,
                updatedAt: msg.timestamp,
            });
        }
    },

    /**
     * Handle chat message
     * @param {Object} msg
     */
    handleChatMessage(msg) {
        // Emit custom event for chat component
        window.dispatchEvent(new CustomEvent("p2p-chat", {
            detail: msg
        }));
    },

    /**
     * Send signal to peer (via WebSocket)
     * @param {string} targetPeerId
     * @param {Object} signal
     */
    sendSignal(targetPeerId, signal) {
        if (window.ws && window.ws.readyState === WebSocket.OPEN) {
            window.ws.send(JSON.stringify({
                type: "SIGNAL",
                targetPeerId,
                signal,
                fromPeerId: window.peerId,
            }));
        }
    },

    /**
     * Handle incoming signal
     * @param {string} peerId
     * @param {Object} signal
     */
    async handleSignal(peerId, signal) {
        let pc = this.peerConnections.get(peerId);
        
        if (!pc) {
            pc = await this.createConnection(peerId);
        }

        try {
            if (signal.type === "offer") {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.sendSignal(peerId, { type: "answer", sdp: answer });
            } else if (signal.type === "answer") {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            } else if (signal.type === "ice-candidate") {
                if (signal.candidate) {
                    await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                }
            }
        } catch (err) {
            console.error("[P2P] Signal handling error:", err);
        }
    },

    /**
     * Broadcast message to all peers
     * @param {Object} msg
     */
    broadcast(msg) {
        const data = JSON.stringify(msg);
        
        this.dataChannels.forEach((dc, peerId) => {
            if (dc.readyState === "open") {
                dc.send(data);
            }
        });
    },

    /**
     * Send image to peer
     * @param {string} peerId
     * @param {Blob} blob
     */
    async sendImage(peerId, blob) {
        const dc = this.dataChannels.get(peerId);
        if (!dc || dc.readyState !== "open") {
            console.warn(`[P2P] Cannot send image - channel not open with ${peerId}`);
            return false;
        }

        try {
            // Send header
            dc.send(JSON.stringify({
                type: "IMG_HEADER",
                size: blob.size,
                mimeType: blob.type,
            }));

            // Send blob in chunks
            const buffer = await blob.arrayBuffer();
            const CHUNK_SIZE = 16384;
            
            for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
                const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
                dc.send(chunk);
            }

            // Send end marker
            dc.send(JSON.stringify({ type: "IMG_END" }));
            
            return true;
        } catch (err) {
            console.error("[P2P] Image send error:", err);
            return false;
        }
    },

    /**
     * Remove a peer connection
     * @param {string} peerId
     */
    removePeer(peerId) {
        const pc = this.peerConnections.get(peerId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(peerId);
        }
        
        const dc = this.dataChannels.get(peerId);
        if (dc) {
            dc.close();
            this.dataChannels.delete(peerId);
        }
    },

    /**
     * Close all connections
     */
    disconnect() {
        this.peerConnections.forEach((pc, peerId) => {
            this.removePeer(peerId);
        });
        console.log("[P2P] Disconnected all peers");
    },
};

// Export
window.P2PStreamer = P2PStreamer;
