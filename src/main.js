/**
 * Main Entry Point - OurBackyard P2P Marketplace
 * Initializes all services and starts the application
 */

// Import services (will be loaded as modules)
import './services/db.js';
import './services/imageUtils.js';
import './services/websocket.js';

/**
 * Bootstrap the application
 */
async function bootstrap() {
    console.log("🚀 Starting OurBackyard...");
    
    try {
        // 1. Initialize database
        window.DBService.init();
        console.log("[Bootstrap] Database initialized");
        
        // 2. Initialize image utilities
        console] Image utils.log("[Bootstrap ready");
        
        // 3. Initialize DID service
        if (window.DIDService?.init) {
            await window.DIDService.init();
            console.log("[Bootstrap] DID service initialized");
        }
        
        // 4. Connect to WebSocket
        window.WSService.connect();
        console.log("[Bootstrap] WebSocket connecting...");
        
        // 5. Load initial data
        await loadInitialData();
        
        console.log("🚀 OurBackyard started successfully");
    } catch (err) {
        console.error("❌ Startup failed:", err);
    }
}

/**
 * Load initial data from local DB
 */
async function loadInitialData() {
    const db = window.db;
    if (!db) return;
    
    // Load display name
    const record = await db.userData.get("displayName");
    if (record?.value) {
        window.displayName = record.value;
        const inputEl = document.getElementById("input-name");
        if (inputEl) inputEl.value = record.value;
    } else {
        // Generate random name
        window.displayName = "User" + Math.floor(Math.random() * 10000);
        await db.userData.put({ key: "displayName", value: window.displayName });
    }
    
    // Load items
    if (window.loadItems) {
        window.loadItems();
    }
}

// Auto-start when DOM is ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
} else {
    bootstrap();
}

// Export for global access
window.AppBootstrap = { bootstrap, loadInitialData };
