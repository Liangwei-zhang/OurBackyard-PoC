// ============ Database Module ============

let db;

function initDatabase() {
    db = window.db = new Dexie("OurBackyardDB");
    
    // Schema version 5
    db.version(5).stores({
        items: '++id, title, sellerId, price, category, status, updatedAt, timestamp, *imageHashes',
        blobs: 'hash, itemId, timestamp, *refs',
        sync: 'key, timestamp',
        userData: 'key',
        systemAssets: 'id, type',
        blocklist: 'target, reason, timestamp'
    });
    
    // Add upgrade function for v5
    db.version(5).upgrade(tx => {
        console.log('[DB] Running v5 upgrade...');
        return tx.table('items').toCollection().modify(item => {
            if (item.imageHash && !item.imageHashes) {
                item.imageHashes = [item.imageHash];
            }
        });
    });

    // Schema version 6 — add itemId index for O(1) dedup of neighbor items
    db.version(6).stores({
        items: '++id, title, sellerId, price, category, status, updatedAt, timestamp, *imageHashes, itemId',
        blobs: 'hash, itemId, timestamp, *refs',
        sync: 'key, timestamp',
        userData: 'key',
        systemAssets: 'id, type',
        blocklist: 'target, reason, timestamp'
    });
    db.version(6).upgrade(tx => {
        console.log('[DB] Running v6 upgrade — indexing itemId...');
        // No data migration needed; itemId already stored, just now indexed
    });

    // Schema version 7 — add chatMessages + deadDrop tables for P2P chat
    db.version(7).stores({
        items:        '++id, title, sellerId, price, category, status, updatedAt, timestamp, *imageHashes, itemId',
        blobs:        'hash, itemId, timestamp, *refs',
        sync:         'key, timestamp',
        userData:     'key',
        systemAssets: 'id, type',
        blocklist:    'target, reason, timestamp',
        chatMessages: '++id, from, to, ts, itemId, direction, read',
        deadDrop:     '++id, toPeerId, createdAt, delivered',
    });
    db.version(7).upgrade(tx => {
        console.log('[DB] Running v7 upgrade — adding chatMessages + deadDrop tables...');
        // New tables, no migration needed
    });

    console.log('[DB] IndexedDB initialized:', db.name, 'v' + db.versions.length);
    return db;
}

/**
 * Save blob with quota check
 */
async function saveBlobWithQuotaCheck(hash, blobData) {
    if (!hash || !blobData) return;
    
    try {
        // Check current storage usage
        if (navigator.storage && navigator.storage.estimate) {
            const { usage, quota } = await navigator.storage.estimate();
            const percentUsed = (usage / quota) * 100;
            
            console.log('[Quota] Storage:', (usage / 1024 / 1024).toFixed(2), 'MB /', (quota / 1024 / 1024).toFixed(2), 'MB (', percentUsed.toFixed(1), '%)');
            
            // If over 80%, clean up old blobs
            if (percentUsed > 80) {
                await cleanupOldBlobs();
            }
        }
        
        // Save blob
        await db.blobs.put({
            hash: hash,
            blob: blobData,
            timestamp: Date.now(),
            size: blobData.size
        });
        
    } catch (err) {
        console.error('[Quota] Save failed:', err);
        // Try cleanup and retry
        await cleanupOldBlobs();
        await db.blobs.put({
            hash: hash,
            blob: blobData,
            timestamp: Date.now(),
            size: blobData.size
        });
    }
}

/**
 * Cleanup old blobs to free space
 */
async function cleanupOldBlobs() {
    try {
        const blobs = await db.blobs
            .orderBy('timestamp')
            .reverse()
            .toArray();
        
        // Keep only most recent 100 blobs
        if (blobs.length > 100) {
            const toDelete = blobs.slice(100).map(b => b.hash);
            await db.blobs.bulkDelete(toDelete);
            console.log('[Quota] Cleaned up', toDelete.length, 'old blobs');
        }
    } catch (err) {
        console.error('[Quota] Cleanup failed:', err);
    }
}

/**
 * Get item by ID
 */
async function getItem(id) {
    return await db.items.get(id);
}

/**
 * Get all items
 */
async function getAllItems() {
    return await db.items.where('status').notEqual('gone').toArray();
}

/**
 * Add or update item
 */
async function saveItem(item) {
    item.updatedAt = Date.now();
    return await db.items.put(item);
}

/**
 * Delete item
 */
async function deleteItem(id) {
    return await db.items.delete(id);
}

/**
 * Get blob by hash
 */
async function getBlob(hash) {
    const blobs = await db.blobs.where('hash').equals(hash).toArray();
    return blobs.length > 0 ? blobs[0] : null;
}

// Export
window.Database = {
    init: initDatabase,
    saveBlob: saveBlobWithQuotaCheck,
    getBlob,
    getItem,
    getAllItems,
    saveItem,
    deleteItem,
    cleanup: cleanupOldBlobs
};
