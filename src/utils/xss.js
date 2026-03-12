/**
 * XSS Protection Utilities
 * OurBackyard P2P Marketplace
 * Sanitizes user input to prevent cross-site scripting attacks
 */

const XSSSanitizer = {
    /**
     * Sanitize HTML string
     * @param {string} dirty - Raw HTML string
     * @returns {string} Sanitized HTML
     */
    sanitize(dirty) {
        if (!dirty) return '';
        
        const temp = document.createElement('div');
        temp.textContent = dirty;
        return temp.innerHTML;
    },
    
    /**
     * Escape HTML special characters
     * @param {string} text
     * @returns {string}
     */
    escapeHtml(text) {
        if (!text) return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    },
    
    /**
     * Create safe text node
     * @param {string} text
     * @returns {Text}
     */
    createTextNode(text) {
        return document.createTextNode(text || '');
    },
    
    /**
     * Set safe text content
     * @param {HTMLElement} element
     * @param {string} text
     */
    setText(element, text) {
        if (element) {
            element.textContent = text || '';
        }
    },
    
    /**
     * Safely set attribute
     * @param {HTMLElement} element
     * @param {string} name
     * @param {string} value
     */
    setAttribute(element, name, value) {
        if (!element || !name) return;
        
        // Only allow safe attributes
        const safeAttrs = [
            'href', 'src', 'alt', 'title', 'class', 'id',
            'data-id', 'data-hash', 'data-item-id',
            'style', 'disabled', 'checked'
        ];
        
        if (safeAttrs.includes(name)) {
            element.setAttribute(name, this.escapeHtml(value || ''));
        }
    },
    
    /**
     * Create element safely
     * @param {string} tag
     * @param {Object} attrs
     * @param {string|HTMLElement} content
     * @returns {HTMLElement}
     */
    createElement(tag, attrs = {}, content = '') {
        const element = document.createElement(tag);
        
        for (const [key, value] of Object.entries(attrs)) {
            this.setAttribute(element, key, value);
        }
        
        if (typeof content === 'string') {
            element.textContent = content;
        } else if (content instanceof HTMLElement) {
            element.appendChild(content);
        }
        
        return element;
    },
    
    /**
     * Validate URL
     * @param {string} url
     * @returns {boolean}
     */
    isSafeUrl(url) {
        if (!url) return false;
        const allowed = ['http:', 'https:', 'data:', 'blob:'];
        try {
            const parsed = new URL(url, window.location.origin);
            return allowed.includes(parsed.protocol);
        } catch {
            return false;
        }
    },
    
    /**
     * Get safe URL (with validation)
     * @param {string} url
     * @returns {string}
     */
    getSafeUrl(url) {
        if (this.isSafeUrl(url)) {
            return url;
        }
        return '';
    },
};

// Export
window.XSSSanitizer = XSSSanitizer;
