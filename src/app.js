// ============ Main Application Module ============

import { initDatabase } from './db.js';
import { escapeHtml, debounce, formatRelativeTime, generateId, triggerHaptic, isMobile } from './utils.js';
import { initDID, signMessage, verifySignature } from './crypto.js';
import { connectWebSocket, sendMessage, disconnect } from './network.js';

// Application state
const AppState = {
    peerId: null,
    displayName: null,
    roomId: 'ourbackyard-calgary-test',
    currentH3Index: null,
    selectedCategory: 'All',
    selectedSort: 'time',
    items: [],
    connectedPeers: 0,
    onlineNeighbors: new Set()
};

// Initialize application
async function initApp() {
    console.log('[App] Initializing OurBackyard...');
    
    // Initialize database
    initDatabase();
    
    // Initialize DID
    await initDID();
    
    // Connect to network
    connectWebSocket();
    
    // Load initial data
    await loadItems();
    
    console.log('[App] Initialization complete');
}

// Load items from database
async function loadItems() {
    const items = await window.db.items
        .where('status')
        .notEqual('gone')
        .toArray();
    
    AppState.items = items;
    renderItems(items);
}

// Render items to DOM
function renderItems(items) {
    const container = document.getElementById('market-grid');
    if (!container) return;
    
    // Clear and render
    container.innerHTML = items.map(item => createItemCard(item)).join('');
}

// Create item card HTML
function createItemCard(item) {
    const escapedTitle = escapeHtml(item.title || '');
    const priceText = item.price === 0 ? '🎁 Free' : `$${item.price}`;
    const timeText = formatRelativeTime(item.updatedAt || Date.now());
    
    return `
        <div class="item-card" onclick="showItemDetail(${item.id})" data-item-id="${item.id}">
            <div class="item-title">${escapedTitle}</div>
            <div class="item-price">${priceText}</div>
            <div class="item-time">${timeText}</div>
        </div>
    `;
}

// Export for global use
window.AppState = AppState;
window.App = {
    init: initApp,
    loadItems,
    renderItems
};
