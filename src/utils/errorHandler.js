/**
 * Error Handler
 * OurBackyard P2P Marketplace
 * Centralized error handling and reporting
 */

const ErrorHandler = {
    errors: [],
    maxErrors: 50,
    
    /**
     * Initialize global error handlers
     */
    init() {
        // Handle uncaught promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            this.handleError(event.reason, 'unhandledrejection');
        });
        
        // Handle JavaScript errors
        window.addEventListener('error', (event) => {
            this.handleError(event.error, 'window.error');
        });
        
        console.log("[ErrorHandler] Initialized");
    },
    
    /**
     * Handle an error
     * @param {Error} error - Error object or message
     * @param {string} source - Error source
     */
    handleError(error, source = 'unknown') {
        const errorInfo = {
            message: error?.message || String(error),
            stack: error?.stack || '',
            source,
            timestamp: Date.now(),
            userAgent: navigator.userAgent,
        };
        
        // Store error
        this.errors.push(errorInfo);
        
        // Limit stored errors
        if (this.errors.length > this.maxErrors) {
            this.errors.shift();
        }
        
        // Log to console
        console.error('[Error]', source + ':', errorInfo.message);
        
        // Report to monitoring (if configured)
        this.reportError(errorInfo);
    },
    
    /**
     * Safe async wrapper
     * @param {Function} fn - Async function
     * @param {*} fallback - Fallback value on error
     * @returns {Promise<*>}
     */
    async safeAsync(fn, fallback = null) {
        try {
            return await fn();
        } catch (error) {
            this.handleError(error, 'safeAsync');
            return fallback;
        }
    },
    
    /**
     * Safe sync wrapper
     * @param {Function} fn - Function
     * @param {*} fallback - Fallback value on error
     * @returns {*}
     */
    safeSync(fn, fallback = null) {
        try {
            return fn();
        } catch (error) {
            this.handleError(error, 'safeSync');
            return fallback;
        }
    },
    
    /**
     * Report error to monitoring service
     * @param {Object} errorInfo
     */
    reportError(errorInfo) {
        // TODO: Integrate with Sentry, LogRocket, etc.
        // Example:
        // if (window.Sentry) {
        //     Sentry.captureException(errorInfo);
        // }
        
        // For now, log to console with context
        console.group('[Error Report]');
        console.log('Time:', new Date(errorInfo.timestamp).toISOString());
        console.log('Source:', errorInfo.source);
        console.log('Message:', errorInfo.message);
        console.log('Stack:', errorInfo.stack);
        console.groupEnd();
    },
    
    /**
     * Get recent errors
     * @param {number} limit - Max errors to return
     * @returns {Array}
     */
    getRecentErrors(limit = 10) {
        return this.errors.slice(-limit);
    },
    
    /**
     * Clear error history
     */
    clear() {
        this.errors = [];
    },
    
    /**
     * Check if there are recent errors
     * @param {number} withinMs - Time window in ms
     * @returns {boolean}
     */
    hasRecentErrors(withinMs = 60000) {
        const now = Date.now();
        return this.errors.some(e => now - e.timestamp < withinMs);
    },
};

// Auto-init
ErrorHandler.init();

// Export
window.ErrorHandler = ErrorHandler;
