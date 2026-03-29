/**
 * Image Utilities Service
 * OurBackyard P2P Marketplace
 * Handles image compression, thumbnails, and content-addressable storage
 */

/**
 * Compress image to max dimensions
 * @param {File} file - Image file to compress
 * @param {number} maxWidth - Maximum width (default 800)
 * @param {number} quality - JPEG quality 0-1 (default 0.7)
 * @returns {Promise<Blob>} Compressed image blob
 */
async function compressImage(file, maxWidth = 800, quality = 0.7) {
    return new Promise((resolve) => {
        const img = new Image();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        img.onload = () => {
            let width = img.width;
            let height = img.height;

            // Scale down if needed
            if (width > maxWidth) {
                height = (height * maxWidth) / width;
                width = maxWidth;
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob(
                (blob) => resolve(blob),
                "image/jpeg",
                quality,
            );
        };

        img.src = URL.createObjectURL(file);
    });
}

/**
 * Generate micro-thumbnail (50px) for instant display
 * @param {File} file - Image file
 * @returns {Promise<Blob>} Micro thumbnail blob
 */
async function generateMicroThumbnail(file) {
    return compressImage(file, 50, 0.5);
}

/**
 * Compute SHA-256 hash of image blob (content addressable)
 * @param {Blob} blob - Image blob
 * @returns {Promise<string>} Hash string
 */
async function computeImageHash(blob) {
    let buffer;
    if (typeof blob.arrayBuffer === "function") {
        buffer = await blob.arrayBuffer();
    } else {
        buffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
            reader.readAsArrayBuffer(blob);
        });
    }
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    return hashHex;
}

/**
 * Object URL Manager - prevents memory leaks from blob URLs
 */
const ObjectUrlManager = {
    urls: new Map(),
    maxCacheSize: 50,

    getOrCreate(hash, blob) {
        if (this.urls.has(hash)) {
            return this.urls.get(hash);
        }
        
        const url = URL.createObjectURL(blob);
        this.urls.set(hash, url);
        
        // LRU eviction
        if (this.urls.size > this.maxCacheSize) {
            const firstKey = this.urls.keys().next().value;
            if (firstKey) {
                URL.revokeObjectURL(this.urls.get(firstKey));
                this.urls.delete(firstKey);
            }
        }
        
        return url;
    },

    clear() {
        for (const url of this.urls.values()) {
            URL.revokeObjectURL(url);
        }
        this.urls.clear();
    },
};

/**
 * Save blob with quota management
 * @param {string} hash - Content hash
 * @param {Blob} blob - Image blob
 */
async function saveBlobWithQuotaCheck(hash, blob) {
    const db = window.db;
    
    try {
        await db.blobs.put({
            hash: hash,
            blob: blob,
            timestamp: Date.now(),
        });
    } catch (err) {
        console.error("[DB] Blob save failed:", err);
        throw err;
    }
}

/**
 * Quota management - clean old blobs when storage is full
 */
async function cleanupOldBlobs() {
    const db = window.db;
    
    await db.transaction('rw', db.blobs, async () => {
        const count = await db.blobs.count();
        const QUOTA_LIMIT = 100;
        
        if (count > QUOTA_LIMIT) {
            const oldest = await db.blobs.orderBy('timestamp').limit(10).toArray();
            for (const old of oldest) {
                await db.blobs.delete(old.hash);
            }
            console.log(`[DB] Cleaned ${oldest.length} old blobs`);
        }
    });
}

// Export
window.ImageUtils = {
    compressImage,
    generateMicroThumbnail,
    computeImageHash,
    ObjectUrlManager,
    saveBlobWithQuotaCheck,
    cleanupOldBlobs,
};
