/**
 * Utility Functions
 * OurBackyard P2P Marketplace
 */

/**
 * Debounce function
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Delay in ms
 * @returns {Function}
 */
function debounce(fn, delay = 300) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * Throttle function
 * @param {Function} fn - Function to throttle
 * @param {limit} delay - Limit in ms
 * @returns {Function}
 */
function throttle(fn, limit = 300) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            setTimeout(() => (inThrottle = false), limit);
        }
    };
}

/**
 * Generate unique ID
 * @returns {string}
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Format timestamp to relative time
 * @param {number} timestamp
 * @returns {string}
 */
function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    
    const intervals = {
        year: 31536000,
        month: 2592000,
        week: 604800,
        day: 86400,
        hour: 3600,
        minute: 60,
    };
    
    for (const [unit, secondsInUnit] of Object.entries(intervals)) {
        const interval = Math.floor(seconds / secondsInUnit);
        if (interval >= 1) {
            return `${interval} ${unit}前`;
        }
    }
    return "剛剛";
}

/**
 * Format price
 * @param {number|string} price
 * @returns {string}
 */
function formatPrice(price) {
    if (price === 0 || price === "0") return "🎁 Free";
    if (price === "swap") return "☕ Swap";
    return `$${price}`;
}

/**
 * Validate image file
 * @param {File} file
 * @returns {Object} { valid: boolean, error?: string }
 */
function validateImage(file) {
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    
    if (!ALLOWED_TYPES.includes(file.type)) {
        return { valid: false, error: "不支持的圖片格式" };
    }
    
    if (file.size > MAX_SIZE) {
        return { valid: false, error: "圖片太大 (最大 10MB)" };
    }
    
    return { valid: true };
}

/**
 * Show toast notification
 * @param {string} message
 * @param {string} type - success, error, info
 */
function showToast(message, type = "info") {
    // Remove existing toast
    const existing = document.querySelector(".toast-notification");
    if (existing) existing.remove();
    
    const toast = document.createElement("div");
    toast.className = `toast-notification toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${type === "success" ? "var(--accent-green)" : type === "error" ? "#f44336" : "var(--primary)"};
        color: #000;
        padding: 12px 24px;
        border-radius: 12px;
        font-weight: 600;
        z-index: 10000;
        opacity: 1;
        transition: opacity 0.3s;
    `;
    
    document.body.appendChild(toast);
    
    // Trigger haptic if available
    if (navigator.vibrate) {
        navigator.vibrate(type === "error" ? [200] : [50]);
    }
    
    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * Copy text to clipboard
 * @param {string} text
 */
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast("已複製到剪貼簿", "success");
    } catch (err) {
        console.error("Copy failed:", err);
    }
}

/**
 * Get H3 index from coordinates
 * @param {number} lat
 * @param {number} lng
 * @param {number} resolution - default 9
 * @returns {string}
 */
function getH3Index(lat, lng, resolution = 9) {
    if (typeof h3 === "undefined") {
        console.warn("[H3] Library not loaded");
        return null;
    }
    return h3.latLngToCell(lat, lng, resolution);
}

/**
 * Format file size
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Export
window.Utils = {
    debounce,
    throttle,
    generateId,
    timeAgo,
    formatPrice,
    validateImage,
    showToast,
    copyToClipboard,
    getH3Index,
    formatBytes,
};
