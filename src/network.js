// ============ Network Module (WebSocket) ============

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

function connectWebSocket() {
    const serverUrl = getWebSocketUrl();
    
    console.log('[WS] Connecting to:', serverUrl);
    ws = new WebSocket(serverUrl);
    
    ws.onopen = () => {
        console.log('[WS] Connected');
        reconnectAttempts = 0;
        updateStatus('connected', 'Connected');
        
        // Send auth
        sendMessage({ type: 'AUTH', did: window.DIDService?.did });
        
        // Request history
        sendMessage({ type: 'REQUEST_HISTORY' });
        
        // Request peers
        sendMessage({ type: 'get-peers' });
        
        // Load items
        window.App?.loadItems();
    };
    
    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
        } catch (err) {
            console.error('[WS] Parse error:', err);
        }
    };
    
    ws.onerror = (error) => {
        console.error('[WS] Error:', error);
    };
    
    ws.onclose = () => {
        console.log('[WS] Disconnected');
        updateStatus('', 'Disconnected');
        
        // Auto-reconnect with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
        reconnectAttempts++;
        
        console.log('[WS] Reconnecting in', delay, 'ms');
        setTimeout(connectWebSocket, delay);
    };
}

function sendMessage(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    } else {
        console.log('[WS] Not connected, queuing message');
    }
}

function handleMessage(msg) {
    console.log('[WS] Message:', msg.type);
    
    switch (msg.type) {
        case 'NEW_ITEM':
            handleNewItem(msg);
            break;
        case 'ITEM_UPDATE':
            handleItemUpdate(msg);
            break;
        case 'peer-count':
            updatePeerCount(msg.count);
            break;
        case 'history':
            handleHistory(msg.items);
            break;
        default:
            console.log('[WS] Unknown message type:', msg.type);
    }
}

function handleNewItem(msg) {
    // Save to database and render
    window.db?.items.put(msg.item);
    window.App?.loadItems();
}

function handleItemUpdate(msg) {
    window.db?.items.update(msg.itemId, msg.updates);
    window.App?.loadItems();
}

function handleHistory(items) {
    if (items && items.length > 0) {
        window.db?.items.bulkPut(items);
        window.App?.loadItems();
    }
}

function updateStatus(status, text) {
    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
        statusEl.textContent = text;
        statusEl.className = 'status-' + status;
    }
}

function updatePeerCount(count) {
    const countEl = document.getElementById('peer-count');
    if (countEl) {
        countEl.textContent = count;
    }
}

function getWebSocketUrl() {
    // Use current host, same protocol
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:80';
    return `${protocol}//${host}`;
}

function disconnect() {
    if (ws) {
        ws.close();
        ws = null;
    }
}

// Export
window.Network = {
    connect: connectWebSocket,
    send: sendMessage,
    disconnect,
    getWebSocketUrl
};
