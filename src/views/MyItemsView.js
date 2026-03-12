/**
 * My Items View
 * OurBackyard P2P Marketplace
 * Handles user's own items management
 */

const MyItemsView = {
    /**
     * Initialize the my items view
     */
    init() {
        console.log("[MyItemsView] Initialized");
    },
    
    /**
     * Load user's items
     * @returns {Promise<Array>}
     */
    async loadMyItems() {
        const db = window.db;
        if (!db) return [];
        
        try {
            const items = await db.items
                .where("sellerId")
                .equals(window.peerId)
                .toArray();
            
            return items;
        } catch (err) {
            console.error("[MyItemsView] Load error:", err);
            return [];
        }
    },
    
    /**
     * Render my items grid
     * @param {Array} items
     */
    render(items) {
        const container = document.getElementById('my-items-grid');
        if (!container) return;
        
        if (items.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📦</div>
                    <div class="empty-text">尚未發布任何商品</div>
                </div>
            `;
            return;
        }
        
        // Render items
        const html = items.map(item => {
            const statusClass = this.getStatusClass(item.status);
            const priceText = window.Utils?.formatPrice?.(item.price) || `$${item.price}`;
            
            return `
                <div class="item-card ${item.status}" data-item-id="${item.id}">
                    <div class="item-info">
                        <div class="item-title">${item.title}</div>
                        <div class="item-price">${priceText}</div>
                        <div class="item-footer">
                            <span class="item-status ${statusClass}">${item.status}</span>
                            <button class="btn-edit" onclick="MyItemsView.editItem(${item.id})">✏️</button>
                            <button class="btn-delete" onclick="MyItemsView.deleteItem(${item.id})">🗑️</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        container.innerHTML = html;
    },
    
    /**
     * Get status CSS class
     * @param {string} status
     * @returns {string}
     */
    getStatusClass(status) {
        switch (status) {
            case "available": return "status-available";
            case "pending": return "status-pending";
            default: return "status-gone";
        }
    },
    
    /**
     * Edit item
     * @param {number} id
     */
    editItem(id) {
        // Show edit modal or navigate to edit form
        if (window.showItemDetail) {
            window.showItemDetail(id);
        }
    },
    
    /**
     * Delete item
     * @param {number} id
     */
    async deleteItem(id) {
        if (!confirm('確定要刪除這個商品嗎？')) {
            return;
        }
        
        const db = window.db;
        if (!db) return;
        
        try {
            await db.items.delete(id);
            
            window.Utils?.showToast?.("已刪除", "success");
            
            // Refresh list
            await this.refresh();
            
        } catch (err) {
            console.error("[MyItemsView] Delete error:", err);
            window.Utils?.showToast?.("刪除失敗", "error");
        }
    },
    
    /**
     * Update item status
     * @param {number} id
     * @param {string} status
     */
    async updateStatus(id, status) {
        const db = window.db;
        if (!db) return;
        
        try {
            await db.items.update(id, {
                status,
                updatedAt: Date.now(),
            });
            
            // Broadcast update
            if (window.WSService?.broadcast) {
                window.WSService.broadcast({
                    type: "ITEM_UPDATE",
                    itemId: id,
                    status,
                    timestamp: Date.now(),
                    sellerId: window.peerId,
                });
            }
            
            window.Utils?.showToast?.("狀態已更新", "success");
            
            // Refresh
            await this.refresh();
            
        } catch (err) {
            console.error("[MyItemsView] Status update error:", err);
            window.Utils?.showToast?.("更新失敗", "error");
        }
    },
    
    /**
     * Refresh the list
     */
    async refresh() {
        const items = await this.loadMyItems();
        this.render(items);
    },
};

// Export
window.MyItemsView = MyItemsView;
