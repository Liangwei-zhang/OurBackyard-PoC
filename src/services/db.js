/**
 * Database Service - IndexedDB via Dexie
 * OurBackyard P2P Marketplace
 */

// Global db reference
let db;

/**
 * Initialize the IndexedDB database
 * @returns {Dexie} Database instance
 */
function initDB() {
    db = new Dexie("OurBackyardDB");
    
    // v4: Initial schema
    db.version(4).stores({
        items: "++id, title, category, price, status, sellerId, h3Index, timestamp",
        blobs: "itemId, hash",
        sync: "key",
        userData: "key",
        systemAssets: "url, hash, version",
        blocklist: "itemHash, reason, timestamp",
    });

    // v5: Add imageHash index for content-addressable storage
    db.version(5).stores({
        items: "++id, imageHash, title, category, price, status, sellerId, h3Index, timestamp",
        blobs: "hash, itemId, timestamp",
        sync: "key",
        userData: "key",
        systemAssets: "url, hash, version",
        blocklist: "itemHash, reason, timestamp",
    });
    
    console.log("[DB] IndexedDB initialized v5 with imageHash index");
    return db;
}

/**
 * Get database instance
 * @returns {Dexie}
 */
function getDB() {
    return db;
}

// Export for module usage
window.DBService = {
    init: initDB,
    get: () => db,
};
