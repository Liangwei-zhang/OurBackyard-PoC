/**
 * Debouncer & Throttler
 * OurBackyard P2P Marketplace
 * Rate limiting utilities for performance optimization
 */

class Debouncer {
    /**
     * @param {number} delay - Delay in ms
     */
    constructor(delay = 300) {
        this.delay = delay;
        this.timeoutId = null;
    }
    
    /**
     * Execute function after delay
     * @param {Function} fn
     * @param {...*} args
     */
    execute(fn, ...args) {
        this.cancel();
        this.timeoutId = setTimeout(() => {
            fn(...args);
        }, this.delay);
    }
    
    /**
     * Cancel pending execution
     */
    cancel() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }
}

class Throttler {
    /**
     * @param {number} limit - Min time between executions in ms
     */
    constructor(limit = 300) {
        this.limit = limit;
        this.lastExecution = 0;
        this.timeoutId = null;
    }
    
    /**
     * Execute function if not throttled
     * @param {Function} fn
     * @param {...*} args
     */
    execute(fn, ...args) {
        const now = Date.now();
        const timeSinceLast = now - this.lastExecution;
        
        if (timeSinceLast >= this.limit) {
            fn(...args);
            this.lastExecution = now;
        } else {
            this.cancel();
            this.timeoutId = setTimeout(() => {
                fn(...args);
                this.lastExecution = Date.now();
            }, this.limit - timeSinceLast);
        }
    }
    
    /**
     * Cancel pending execution
     */
    cancel() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }
}

// Pre-configured wrappers
const debounce = (fn, delay = 300) => {
    const debouncer = new Debouncer(delay);
    return (...args) => debouncer.execute(fn, ...args);
};

const throttle = (fn, limit = 300) => {
    const throttler = new Throttler(limit);
    return (...args) => throttler.execute(fn, ...args);
};

// Export
window.Debouncer = Debouncer;
window.Throttler = Throttler;
window.debounce = debounce;
window.throttle = throttle;
