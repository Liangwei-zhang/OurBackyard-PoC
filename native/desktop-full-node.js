// Desktop Full Node for OurBackyard
// High-capability peer that helps the network

const DesktopFullNode = {
  isRunning: false,
  config: {
    // Full node capabilities
    minMemoryGB: 8,
    minCores: 4,
    // Services to enable
    enableDataProxy: true,
    enableLLMFilter: true,
    enable24hSync: true,
    enableNATTraversal: true
  },
  
  // Check if device can run as full node
  async checkCapabilities() {
    // Memory estimate
    let memoryGB = 4;
    if (navigator.deviceMemory) {
      memoryGB = navigator.deviceMemory;
    } else if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      memoryGB = Math.round(estimate.quota / (1024 * 1024 * 1024));
    }
    
    // CPU cores
    const cores = navigator.hardwareConcurrency || 2;
    
    // Storage
    let storageGB = 10;
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      storageGB = Math.round((estimate.quota - estimate.usage) / (1024 * 1024 * 1024));
    }
    
    // Check if likely desktop (not perfect but heuristic)
    const isDesktop = !('ontouchstart' in window) || memoryGB >= 8;
    
    const capabilities = {
      isCapable: memoryGB >= this.config.minMemoryGB && cores >= this.config.minCores,
      isDesktop,
      memoryGB,
      cores,
      storageGB,
      canEnableFullMode: memoryGB >= 16 && cores >= 8
    };
    
    console.log('[Desktop] Capabilities:', capabilities);
    return capabilities;
  },
  
  // Start as full node
  async start(peerId, h3Index, options = {}) {
    const caps = await this.checkCapabilities();
    
    if (!caps.isCapable) {
      console.log('[Desktop] Device not capable of full node');
      return { success: false, reason: 'not_capable', capabilities: caps };
    }
    
    this.peerId = peerId;
    this.h3Index = h3Index;
    this.options = { ...this.config, ...options };
    
    // Enable services based on capability
    const services = [];
    
    if (this.options.enableDataProxy && caps.isDesktop) {
      services.push('data-proxy');
      await this.startDataProxy();
    }
    
    if (this.options.enable24hSync && caps.isDesktop) {
      services.push('24h-sync');
      await this.start24hSync();
    }
    
    if (this.options.enableLLMFilter && caps.canEnableFullMode) {
      services.push('llm-filter');
      await this.startLLMFilter();
    }
    
    this.isRunning = true;
    
    console.log('[Desktop] Full node started with services:', services);
    
    return {
      success: true,
      services,
      capabilities: caps
    };
  },
  
  // Data proxy service (help other peers with data)
  async startDataProxy() {
    this.dataProxy = {
      // Cache for nearby peers
      cache: new Map(),
      
      // Store item on behalf of peer
      async storeItem(item) {
        this.cache.set(item.id, {
          ...item,
          storedAt: Date.now(),
          storedBy: this.peerId
        });
      },
      
      // Get item for peer
      async getItem(itemId) {
        return this.cache.get(itemId);
      },
      
      // Get all stored items for H3
      async getItemsForH3(h3Index) {
        return Array.from(this.cache.values())
          .filter(item => item.h3Index === h3Index);
      },
      
      // Cleanup old items
      cleanup() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        for (const [id, item] of this.cache) {
          if (now - item.storedAt > maxAge) {
            this.cache.delete(id);
          }
        }
      }
    };
    
    // Periodic cleanup
    this.dataProxyCleanup = setInterval(() => this.dataProxy.cleanup(), 60 * 60 * 1000);
    
    console.log('[Desktop] Data proxy service started');
  },
  
  // 24/7 sync service
  async start24hSync() {
    this.syncService = {
      // Always-online sync
      status: 'active',
      lastSync: Date.now(),
      
      // Sync with peers
      async syncWith(peer) {
        console.log('[Desktop] Syncing with:', peer?.substring(0, 8));
        this.lastSync = Date.now();
      },
      
      // Get sync status
      getStatus() {
        return {
          status: this.status,
          uptime: Date.now() - this.startTime,
          lastSync: this.lastSync
        };
      }
    };
    
    this.syncService.startTime = Date.now();
    
    // Periodic sync attempts
    this.syncInterval = setInterval(async () => {
      // Find peers and sync
      const peers = await this.findPeersToSync();
      for (const peer of peers) {
        await this.syncService.syncWith(peer);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
    
    console.log('[Desktop] 24/7 sync service started');
  },
  
  // Find peers that need sync help
  async findPeersToSync() {
    // Query known peers
    // In production, query DHT for peers needing sync
    return [];
  },
  
  // LLM content filter (high-end only)
  async startLLMFilter() {
    this.llmFilter = {
      enabled: true,
      model: 'local-small',
      
      // Analyze content
      async analyze(content) {
        // Simulated LLM analysis
        // In production, load actual local model
        
        const words = content.toLowerCase();
        
        // Simple spam detection
        const spamWords = ['buy now', 'click here', 'free money', 'act now'];
        const isSpam = spamWords.some(w => words.includes(w));
        
        // Sentiment
        const positive = ['thanks', 'great', 'helpful', 'appreciate'];
        const sentiment = positive.some(w => words.includes(w)) ? 'positive' : 'neutral';
        
        return {
          isSpam,
          sentiment,
          confidence: 0.8,
          filtered: false
        };
      },
      
      // Filter batch
      async filterBatch(items) {
        const results = [];
        for (const item of items) {
          const analysis = await this.analyze(item.title + ' ' + item.description);
          results.push({ ...item, analysis });
        }
        return results;
      }
    };
    
    console.log('[Desktop] LLM filter service started');
  },
  
  // Announce full node to network
  async announce() {
    const announcement = {
      type: 'FULL_NODE_ANNOUNCE',
      peerId: this.peerId,
      h3Index: this.h3Index,
      services: Object.keys(this).filter(k => !k.startsWith('_')),
      capabilities: await this.checkCapabilities(),
      timestamp: Date.now()
    };
    
    // Broadcast via DHT
    try {
      localStorage.setItem('fullnode_' + this.peerId, JSON.stringify(announcement));
    } catch (e) {}
    
    console.log('[Desktop] Announced as full node');
  },
  
  // Stop full node
  async stop() {
    if (this.dataProxyCleanup) clearInterval(this.dataProxyCleanup);
    if (this.syncInterval) clearInterval(this.syncInterval);
    
    this.isRunning = false;
    
    console.log('[Desktop] Full node stopped');
  },
  
  // Get full node status
  getStatus() {
    return {
      isRunning: this.isRunning,
      h3Index: this.h3Index,
      services: {
        dataProxy: !!this.dataProxy,
        syncService: !!this.syncService,
        llmFilter: !!this.llmFilter
      }
    };
  }
};

// Export
window.DesktopFullNode = DesktopFullNode;
console.log('[OurBackyard] Desktop Full Node loaded');
