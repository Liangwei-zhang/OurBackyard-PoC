// Client-side PoW Spam Protection for OurBackyard
// Prevents spam with local proof-of-work

const PoWSpamProtection = {
  config: {
    difficulty: 1000,      // Higher = harder
    maxDelay: 3000,       // Max 3 seconds
    enabled: true,
    cacheTime: 60000      // Cache result for 1 minute
  },
  
  cache: new Map(),
  
  // Compute proof of work
  async compute(target, options = {}) {
    const { difficulty = this.config.difficulty } = options;
    
    // Check cache first
    const cached = this.cache.get(target);
    if (cached && Date.now() - cached.time < this.config.cacheTime) {
      console.log('[PoW] Using cached result');
      return cached;
    }
    
    const start = Date.now();
    let nonce = 0;
    const targetStr = target.toString();
    
    // Parallel workers for faster computation
    const workers = navigator.hardwareConcurrency || 2;
    const chunkSize = 10000;
    
    // Simple hash function
    const simpleHash = (str) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    };
    
    // Find valid hash
    let found = false;
    let result = null;
    
    while (!found) {
      // Check timeout
      if (Date.now() - start > this.config.maxDelay) {
        throw new Error('PoW timeout - try again');
      }
      
      const hash = simpleHash(targetStr + nonce);
      
      // Check if hash meets difficulty
      if (hash % difficulty === 0) {
        found = true;
        result = {
          nonce,
          hash: hash.toString(16),
          difficulty,
          time: Date.now() - start
        };
      }
      
      nonce++;
      
      // Yield to prevent freezing
      if (nonce % 1000 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
    
    // Cache result
    this.cache.set(target, result);
    
    console.log('[PoW] Computed in', result.time, 'ms, nonce:', result.nonce);
    
    return result;
  },
  
  // Verify proof of work
  async verify(target, proof, options = {}) {
    const { difficulty = this.config.difficulty } = options;
    
    const simpleHash = (str) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    };
    
    const hash = simpleHash(target.toString() + proof.nonce);
    
    return hash % difficulty === 0 && hash <= 0xFFFFFFFF;
  },
  
  // Get current difficulty based on recent spam attempts
  getAdaptiveDifficulty() {
    // Increase difficulty if many spam attempts detected
    // This would integrate with reputation system
    return this.config.difficulty;
  },
  
  // Clear cache
  clearCache() {
    this.cache.clear();
  },
  
  // Check if PoW is required for this action
  requiresPoW(action) {
    // Always require for broadcasts, optional for P2P
    const required = ['broadcast', 'new_item', 'emergency_alert'];
    return required.includes(action);
  }
};

// Export
window.PoWSpamProtection = PoWSpamProtection;
console.log('[OurBackyard] PoW Spam Protection loaded');
