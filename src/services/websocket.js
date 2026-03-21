/**
 * WebSocket/P2P Communication Service
 * OurBackyard P2P Marketplace
 */

// Connection state
let ws = null;
let dataChannels = {};
let heartbeatInterval = null;
let peerConnections = {}; // peerId -> RTCPeerConnection
let isBackground = false;

// Message deduplication
const recentMsgIds = new Set();
const MAX_MSG_CACHE = 500;

/**
 * Generate authentication token for WebSocket
 * Uses peer ID and timestamp for simple auth
 * @returns {Promise<string>} Base64 encoded token
 */
async function generateAuthToken() {
    const payload = {
        peerId: window.peerId || await window.DIDService?.getPeerId?.(),
        timestamp: Date.now(),
        roomId: window.roomId || "ourbackyard-calgary-test",
    };
    
    // Simple base64 encoding (in production, use proper JWT)
    return btoa(JSON.stringify(payload));
}

/**
 * Send authentication token to server
 */
async function sendAuthToken() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    try {
        const token = await generateAuthToken();
        ws.send(JSON.stringify({
            type: "AUTH",
            token: token,
            peerId: window.peerId,
        }));
        console.log("[WS] Auth token sent");
    } catch (err) {
        console.error("[WS] Auth token failed:", err);
    }
}

/**
 * Generate unique message ID
 * @param {Object} msg - Message object
 * @returns {string} Unique message ID
 */
function generateMsgId(msg) {
    return msg.type + '-' + (msg.messageId || msg.itemId || msg.id || '') + '-' + (msg.timestamp || Date.now());
}

/**
 * Check if message was already seen
 * @param {string} msgId - Message ID
 * @returns {boolean}
 */
function isMessageSeen(msgId) {
    if (!msgId) return false;
    return recentMsgIds.has(msgId);
}

/**
 * Mark message as seen
 * @param {string} msgId - Message ID
 */
function markMessageSeen(msgId) {
    if (!msgId) return;
    if (recentMsgIds.size >= MAX_MSG_CACHE) {
        const first = recentMsgIds.values().next().value;
        if (first) recentMsgIds.delete(first);
    }
    recentMsgIds.add(msgId);
}

/**
 * Connect to WebSocket server
 * SECURITY: Always uses WSS (encrypted) regardless of environment
 * @param {string} serverUrl - WebSocket server URL (optional)
 */
function connectWebSocket(serverUrl) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("[WS] Already connected");
        return;
    }

    // SECURITY: Always use WSS for encrypted connections
    // Even in development, prefer WSS for security
    let wsUrl;
    if (serverUrl) {
        wsUrl = serverUrl;
    } else {
        // Force WSS for security
        const host = location.host;
        const roomId = window.roomId || "ourbackyard-calgary-test";
        wsUrl = `wss://${host}/ws/${encodeURIComponent(roomId)}`;
    }
    
    console.log("[WS] Connecting (secure):", wsUrl.replace(/wss?:\/\//, '***://'));
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = async () => {
            console.log("[WS] Connected (secure)");
            
            // Send authentication token for security
            await sendAuthToken();
            
            // Send handshake
            ws.send(JSON.stringify({
                type: "HANDSHAKE",
                peerId: window.peerId,
                displayName: window.displayName,
            }));
            
            // Start heartbeat
            startHeartbeat();
        };
        
        ws.onmessage = (event) => {
            handleWebSocketMessage(event.data);
        };
        
        ws.onerror = (err) => {
            console.error("[WS] Error:", err);
        };
        
        ws.onclose = () => {
            console.log("[WS] Disconnected");
            stopHeartbeat();
            // Reconnect after delay
            setTimeout(() => connectWebSocket(serverUrl), 5000);
        };
    } catch (err) {
        console.error("[WS] Connection failed:", err);
    }
}

/**
 * Start heartbeat to keep connection alive
 */
function startHeartbeat() {
    if (heartbeatInterval) return;
    
    heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: "HEARTBEAT",
                peerId: window.peerId,
                timestamp: Date.now(),
            }));
        }
    }, 30000);
}

/**
 * Stop heartbeat
 */
function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

/**
 * Handle incoming WebSocket message
 * @param {string} data - Raw message data
 */
async function handleWebSocketMessage(data) {
    try {
        const msg = JSON.parse(data);
        const msgId = generateMsgId(msg);
        
        // Deduplication
        if (isMessageSeen(msgId)) {
            return;
        }
        markMessageSeen(msgId);
        
        // Route message by type
        switch (msg.type) {
            case "NEW_ITEM":
                await handleNewItem(msg);
                break;
            case "ITEM_UPDATE":
                await handleItemUpdate(msg);
                break;
            case "REQ_IMAGE":
                await handleImageRequest(msg);
                break;
            case "IMG_HEADER":
            case "IMG_CHUNK":
                await handleImageChunk(msg);
                break;
            case "APP_UPDATE_CHECK":
            case "APP_UPDATE_AVAILABLE":
                // Handle app updates
                break;
            default:
                console.log("[WS] Unknown message type:", msg.type);
        }
    } catch (err) {
        console.error("[WS] Message parse error:", err);
    }
}

/**
 * Handle new item broadcast
 * @param {Object} msg - Message
 */
async function handleNewItem(msg) {
    const db = window.db;
    if (!db) return;
    
    // Check if already exists
    const existing = await db.items.where("itemId").equals(msg.itemId || msg.id).first();
    if (existing) return;
    
    // Add to local DB
    await db.items.put({
        ...msg,
        itemId: msg.itemId || msg.id,
        syncedAt: Date.now(),
    });
    
    console.log("[WS] New item received:", msg.title);
    
    // Notify UI
    if (window.loadItems) {
        window.loadItems();
    }
}

/**
 * Handle item update
 * @param {Object} msg - Message
 */
async function handleItemUpdate(msg) {
    const db = window.db;
    if (!db) return;
    
    await db.items.where("itemId").equals(msg.itemId).first().then(async (item) => {
        if (item) {
            await db.items.update(item.id, {
                status: msg.status,
                price: msg.price,
                updatedAt: msg.timestamp,
            });
        }
    });
}

/**
 * Handle image request from peer
 * @param {Object} msg - Message
 */
async function handleImageRequest(msg) {
    const { imageHash, requesterId } = msg;
    const db = window.db;
    
    // Find image in local blobs
    const blob = await db.blobs.where("hash").equals(imageHash).first();
    if (blob && blob.blob) {
        // Send image back to requester
        sendImageData(requesterId, imageHash, blob.blob);
    }
}

/**
 * Send image data to peer
 * @param {string} peerId - Target peer ID
 * @param {string} imageHash - Content hash
 * @param {Blob} blob - Image blob
 */
async function sendImageData(peerId, imageHash, blob) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    const buffer = await blob.arrayBuffer();
    const CHUNK_SIZE = 16384;
    const totalSize = buffer.byteLength;
    
    // Send header first
    ws.send(JSON.stringify({
        type: "IMG_HEADER",
        imageHash,
        peerId: window.peerId,
        size: totalSize,
        mimeType: blob.type,
    }));
    
    // Send chunks
    for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
        const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
        const chunkBase64 = btoa(String.fromCharCode(...new Uint8Array(chunk)));
        
        ws.send(JSON.stringify({
            type: "IMG_CHUNK",
            imageHash,
            data: chunkBase64,
            offset,
            expectedSize: totalSize,
        }));
    }
    
    // Send end marker
    ws.send(JSON.stringify({
        type: "IMG_END",
        imageHash,
    }));
}

/**
 * Handle incoming image chunk
 * @param {Object} msg - Message
 */
async function handleImageChunk(msg) {
    const { imageHash, data, offset, expectedSize } = msg;
    
    // Initialize storage if needed
    if (!window.incomingImages) {
        window.incomingImages = {};
    }
    
    if (!window.incomingImages[imageHash]) {
        window.incomingImages[imageHash] = {
            chunks: [],
            received: 0,
            expectedSize: expectedSize || 999999999,
        };
    }
    
    // Decode base64 chunk
    const binaryString = atob(data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    window.incomingImages[imageHash].chunks.push(bytes.buffer);
    window.incomingImages[imageHash].received += bytes.length;
    
    // Check if complete
    const imgData = window.incomingImages[imageHash];
    if (imgData.received >= imgData.expectedSize) {
        // Assemble and save
        const blob = new Blob(imgData.chunks, { type: "image/jpeg" });
        await window.ImageUtils.saveBlobWithQuotaCheck(imageHash, blob);
        
        // Cleanup
        delete window.incomingImages[imageHash];
        
        // Notify UI
        window.dispatchEvent(new CustomEvent("p2p-image-ready", { 
            detail: { imageHash } 
        }));
    }
}

/**
 * Broadcast message to all connected peers
 * @param {Object} msg - Message to broadcast
 */
function broadcast(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

/**
 * Get WebSocket connection status
 * @returns {string} Connection status
 */
function getConnectionStatus() {
    if (!ws) return "disconnected";
    switch (ws.readyState) {
        case WebSocket.CONNECTING: return "connecting";
        case WebSocket.OPEN: return "connected";
        case WebSocket.CLOSING: return "closing";
        case WebSocket.CLOSED: return "disconnected";
        default: return "unknown";
    }
}

// Export
window.WSService = {
    connect: connectWebSocket,
    disconnect: () => ws?.close(),
    broadcast,
    getStatus: getConnectionStatus,
    sendImageData,
};
