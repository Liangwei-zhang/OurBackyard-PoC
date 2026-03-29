/**
 * Image Lazy Loader Component
 * OurBackyard P2P Marketplace
 * Uses IntersectionObserver for efficient lazy loading
 */

const ImageLazyLoader = {
    observer: null,
    loadedImages: new Set(),
    
    /**
     * Initialize the lazy loader
     */
    init() {
        if (typeof IntersectionObserver === 'undefined') {
            console.warn("[LazyLoader] IntersectionObserver not supported");
            return;
        }
        
        this.observer = new IntersectionObserver(
            (entries) => this.handleIntersection(entries),
            {
                rootMargin: '50px',
                threshold: 0.1,
            }
        );
        
        console.log("[LazyLoader] Initialized");
    },
    
    /**
     * Observe an image element
     * @param {HTMLImageElement} img - Image element to observe
     */
    observe(img) {
        if (!this.observer) {
            this.init();
        }
        
        if (img && !img.dataset.loaded) {
            this.observer.observe(img);
        }
    },
    
    /**
     * Stop observing an image
     * @param {HTMLImageElement} img
     */
    unobserve(img) {
        if (this.observer) {
            this.observer.unobserve(img);
        }
    },
    
    /**
     * Handle intersection events
     * @param {IntersectionObserverEntry[]} entries
     */
    async handleIntersection(entries) {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                const img = entry.target;
                this.observer.unobserve(img);
                
                await this.loadImage(img);
            }
        }
    },
    
    /**
     * Load image from local storage or request from network
     * @param {HTMLImageElement} img
     */
    async loadImage(img) {
        const hash = img.dataset.hash;
        const itemId = img.dataset.itemId;
        
        if (!hash && !itemId) return;
        
        if (this.loadedImages.has(hash || itemId)) {
            return;
        }
        
        try {
            let imageUrl = null;
            const db = window.db;
            
            // Try to load from IndexedDB first
            if (db && hash) {
                const blobRecord = await db.blobs.where("hash").equals(hash).first();
                if (blobRecord?.blob) {
                    imageUrl = URL.createObjectURL(blobRecord.blob);
                }
            }
            
            // If not found locally, request from network
            if (!imageUrl && window.WSService) {
                // Request image from peers
                this.requestImageFromPeers(hash, itemId);
                return;
            }
            
            if (imageUrl) {
                img.src = imageUrl;
                img.dataset.loaded = "true";
                img.style.filter = "none";
                this.loadedImages.add(hash || itemId);
            }
        } catch (err) {
            console.error("[LazyLoader] Load error:", err);
        }
    },
    
    /**
     * Request image from peers via WebSocket
     * @param {string} hash
     * @param {string} itemId
     */
    requestImageFromPeers(hash, itemId) {
        const socket = window.ws;
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: "REQ_IMAGE",
                imageHash: hash,
                itemId: itemId,
                requesterId: window.peerId,
            }));
            console.log("[LazyLoader] Requested image:", hash);
        }
    },
    
    /**
     * Handle incoming image from P2P
     * @param {string} hash
     * @param {Blob} blob
     */
    async handleIncomingImage(hash, blob) {
        // Find and update all images with this hash
        const images = document.querySelectorAll(`img[data-hash="${hash}"]`);
        
        if (images.length > 0) {
            const imageUrl = URL.createObjectURL(blob);
            
            images.forEach(img => {
                img.src = imageUrl;
                img.dataset.loaded = "true";
                img.style.filter = "none";
            });
            
            this.loadedImages.add(hash);
            console.log("[LazyLoader] Updated", images.length, "images with hash:", hash);
        }
    },
    
    /**
     * Disconnect observer (cleanup)
     */
    disconnect() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    },
    
    /**
     * Clear loaded images cache
     */
    clearCache() {
        this.loadedImages.clear();
    },
};

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ImageLazyLoader.init());
} else {
    ImageLazyLoader.init();
}

// Export
window.ImageLazyLoader = ImageLazyLoader;
