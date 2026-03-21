/**
 * Browse View
 * OurBackyard P2P Marketplace
 * Handles marketplace item listing and filtering
 */

const BrowseView = {
    currentFilter: "All",
    currentSort: "time",
    
    /**
     * Initialize the browse view
     */
    init() {
        this.bindEvents();
        console.log("[BrowseView] Initialized");
    },
    
    /**
     * Bind UI events
     */
    bindEvents() {
        // Category filter
        const categoryBtns = document.querySelectorAll('.filter-category');
        categoryBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.setCategory(btn.dataset.category);
            });
        });
        
        // Sort buttons
        const sortBtns = document.querySelectorAll('.sort-btn');
        sortBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.setSort(btn.dataset.sort);
            });
        });
    },
    
    /**
     * Set category filter
     * @param {string} category
     */
    setCategory(category) {
        this.currentFilter = category;
        
        // Update UI
        document.querySelectorAll('.filter-category').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.category === category);
        });
        
        // Reload items
        if (window.loadItems) {
            window.loadItems();
        }
    },
    
    /**
     * Set sort order
     * @param {string} sort
     */
    setSort(sort) {
        this.currentSort = sort;
        
        // Reload items
        if (window.loadItems) {
            window.loadItems();
        }
    },
    
    /**
     * Filter items by category
     * @param {Array} items
     * @returns {Array}
     */
    filterByCategory(items) {
        if (this.currentFilter === "All") {
            return items;
        }
        
        return items.filter(item => item.category === this.currentFilter);
    },
    
    /**
     * Sort items
     * @param {Array} items
     * @returns {Array}
     */
    sortItems(items) {
        const sorted = [...items];
        
        switch (this.currentSort) {
            case "time":
                sorted.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                break;
            case "price-low":
                sorted.sort((a, b) => (a.price || 0) - (b.price || 0));
                break;
            case "price-high":
                sorted.sort((a, b) => (b.price || 0) - (a.price || 0));
                break;
        }
        
        return sorted;
    },
    
    /**
     * Get filter state
     * @returns {Object}
     */
    getState() {
        return {
            category: this.currentFilter,
            sort: this.currentSort,
        };
    },
};

// Export
window.BrowseView = BrowseView;
