/**
 * Content Moderator Service
 * OurBackyard P2P Marketplace
 * Handles content reporting and spam prevention
 */

const ContentModerator = {
    blocklist: new Set(),
    
    /**
     * Initialize the moderator
     */
    async init() {
        const db = window.db;
        if (!db) return;
        
        // Load blocklist from local DB
        try {
            const blocked = await db.blocklist.toArray();
            blocked.forEach(item => {
                this.blocklist.add(item.itemHash || item.itemId);
            });
            console.log("[Moderator] Blocklist loaded:", this.blocklist.size, "items");
        } catch (err) {
            console.error("[Moderator] Failed to load blocklist:", err);
        }
    },
    
    /**
     * Check if item is blocked
     * @param {string} itemId 
     * @returns {boolean}
     */
    isBlocked(itemId) {
        return this.blocklist.has(itemId);
    },
    
    /**
     * Report inappropriate content
     * @param {string} itemId - Item or content ID
     * @param {string} reason - Reason for report
     */
    async reportItem(itemId, reason = "inappropriate") {
        const db = window.db;
        if (!db) return;
        
        try {
            // Add to blocklist
            await db.blocklist.put({
                itemHash: itemId,
                reason: reason,
                timestamp: Date.now(),
                reporterId: window.peerId,
            });
            
            this.blocklist.add(itemId);
            
            // Show feedback
            window.Utils?.showToast?.("已舉報", "success");
            
            console.log("[Moderator] Reported:", itemId, reason);
        } catch (err) {
            console.error("[Moderator] Report failed:", err);
        }
    },
    
    /**
     * Remove from blocklist
     * @param {string} itemId 
     */
    async unblockItem(itemId) {
        const db = window.db;
        if (!db) return;
        
        try {
            await db.blocklist.where("itemHash").equals(itemId).delete();
            this.blocklist.delete(itemId);
            console.log("[Moderator] Unblocked:", itemId);
        } catch (err) {
            console.error("[Moderator] Unblock failed:", err);
        }
    },
    
    /**
     * Filter items by blocklist
     * @param {Array} items - Array of items
     * @returns {Array} Filtered items
     */
    filterItems(items) {
        return items.filter(item => {
            const id = item.id || item.itemId;
            return !this.isBlocked(id);
        });
    },
};

// Export
window.ContentModerator = ContentModerator;
