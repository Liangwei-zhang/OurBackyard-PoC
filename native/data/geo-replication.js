// Geo-Replication Protocol for OurBackyard
// Data mirroring and auto-backup based on H3 neighbor nodes

const GeoReplicationProtocol = {
  config: {
    // Replication parameters
    neighborDepth: 3,           // H3 ring depth for replication (K=3)
    redundancyCount: 3,         // Minimum number of mirrors
    maxReplicationDistance: 3,  // Max H3 rings to replicate to
    
    // Erasure coding
    shardCount: 10,            // Total shards
    requiredShards: 3,         // Minimum shards to reconstruct (3/10 = 30%)
    
    // Timing
    replicationInterval: 60000, // Check every minute
    mirrorHealthCheck: 300000,  // Check mirror health every 5 min
    
    // Priority
    priorityH3Rings: [0, 1, 2], // Priority 0 = closest
  },
  
  db: null,
  peerId: null,
  h3Index: null,
  mirrors: new Map(),      // itemId -> MirrorInfo
  pendingReplication: new Set(),
  
  // Initialize Geo-Replication Protocol
  async init(peerId, h3Index) {
    this.peerId = peerId;
    this.h3Index = h3Index;
    
    // Open IndexedDB for replication state
    this.db = new Dexie('GeoReplicationDB');
    this.db.version(1).stores({
      mirrors: 'itemId, peerId, h3Ring, timestamp',
      shards: 'shardId, itemId, peerId, data',
      health: 'peerId, lastCheck, status',
      config: 'key'
    });
    
    console.log('[GeoRep] Initialized for H3:', h3Index);
    
    // Start replication loop
    this.startReplicationLoop();
    
    return this;
  },
  
  // Get neighbor H3 indices at different ring depths
  getNeighborH3Indices(h3Index, depth = 3) {
    // Get H3 indices at k-ring distance
    // In production, use h3.kRing()
    const neighbors = new Set();
    
    // Simulate neighbor discovery
    // In production, query DHT/mDNS for peers in each ring
    for (let ring = 1; ring <= depth; ring++) {
      // Add logic to find actual neighbors at this ring distance
      // This would query known peers and filter by H3 distance
    }
    
    return Array.from(neighbors);
  },
  
  // Get all known peers grouped by H3 ring distance
  async getPeersByRing() {
    const peersByRing = {
      0: [], // Same H3
      1: [], // Adjacent H3
      2: [], // 2 rings away
      3: []  // 3+ rings away
    };
    
    // Query all known peers
    // In production, this would aggregate from DHT, mDNS, BLE
    const allPeers = await this.getAllKnownPeers();
    
    for (const peer of allPeers) {
      const distance = this.getH3Distance(this.h3Index, peer.h3Index);
      const ring = Math.min(distance, 3);
      peersByRing[ring].push(peer);
    }
    
    return peersByRing;
  },
  
  // Calculate H3 distance (ring depth)
  getH3Distance(h3Index1, h3Index2) {
    // In production, use h3.gridDisk() to calculate actual distance
    // For now, simple string comparison as fallback
    if (h3Index1 === h3Index2) return 0;
    
    // Simple distance metric - compare last characters
    let distance = 0;
    const minLen = Math.min(h3Index1.length, h3Index2.length);
    for (let i = minLen - 1; i >= 0; i--) {
      if (h3Index1[i] !== h3Index2[i]) {
        distance++;
        if (distance >= 3) break;
      }
    }
    return distance;
  },
  
  // Get all known peers from various sources
  async getAllKnownPeers() {
    const peers = [];
    
    // From mDNS
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('mDNS_') || key.startsWith('dht_'))) {
          try {
            const data = JSON.parse(localStorage.getItem(key));
            if (data.peerId !== this.peerId && data.h3Index) {
              peers.push({
                peerId: data.peerId,
                h3Index: data.h3Index,
                source: key.startsWith('dht_') ? 'dht' : 'mdns',
                lastSeen: data.timestamp
              });
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    
    return peers;
  },
  
  // ============ Core Replication Functions ============
  
  // Replicate item to neighbor nodes
  async replicateItem(item, options = {}) {
    const {
      force = false,
      priority = 'normal'
    } = options;
    
    // Get peers grouped by ring
    const peersByRing = await this.getPeersByRing();
    
    // Calculate target redundancy based on item importance
    const targetRedundancy = this.calculateRedundancy(item);
    
    // Current mirrors
    const currentMirrors = await this.db.mirrors
      .where('itemId')
      .equals(item.id)
      .toArray();
    
    // If already have enough mirrors, skip
    if (!force && currentMirrors.length >= targetRedundancy) {
      console.log('[GeoRep] Sufficient mirrors for:', item.id);
      return { replicated: false, reason: 'sufficient_mirrors' };
    }
    
    // Need more mirrors
    const needed = targetRedundancy - currentMirrors.length;
    
    // Priority: ring 0 > ring 1 > ring 2 > ring 3
    const targets = [];
    for (const ring of this.config.priorityH3Rings) {
      const ringPeers = peersByRing[ring] || [];
      for (const peer of ringPeers) {
        // Skip if already mirroring
        if (!currentMirrors.find(m => m.peerId === peer.peerId)) {
          targets.push({ peer, ring });
        }
        if (targets.length >= needed) break;
      }
      if (targets.length >= needed) break;
    }
    
    // Send replication requests
    const results = [];
    for (const target of targets) {
      const success = await this.sendReplicationRequest(target.peer, item);
      results.push({ peerId: target.peer.peerId, success });
      
      // Record mirror
      if (success) {
        await this.db.mirrors.add({
          itemId: item.id,
          peerId: target.peer.peerId,
          h3Ring: target.ring,
          timestamp: Date.now(),
          status: 'active'
        });
      }
    }
    
    console.log('[GeoRep] Replicated', item.id, 'to', results.filter(r => r.success).length, 'peers');
    
    return {
      replicated: true,
      targets: results.length,
      successful: results.filter(r => r.success).length
    };
  },
  
  // Calculate redundancy based on item properties
  calculateRedundancy(item) {
    let redundancy = this.config.redundancyCount;
    
    // Increase for important items
    if (item.price > 100) redundancy += 1;  // Expensive items
    if (item.category === 'Tools') redundancy += 1;  // High demand
    if (item.images?.length > 0) redundancy += 1;  // Has images
    
    return Math.min(redundancy, 10); // Cap at 10
  },
  
  // Send replication request to peer
  async sendReplicationRequest(peer, item) {
    // In production, this would use Libp2p/dht to send
    // For now, store request in localStorage for peer to pick up
    try {
      const request = {
        type: 'REPLICATION_REQUEST',
        itemId: item.id,
        item: {
          title: item.title,
          price: item.price,
          category: item.category,
          h3Index: item.h3Index,
          sellerId: item.sellerId,
          timestamp: item.timestamp
          // Don't replicate full image to save bandwidth - just metadata
        },
        requestedBy: this.peerId,
        timestamp: Date.now()
      };
      
      localStorage.setItem('rep_req_' + item.id + '_' + this.peerId, JSON.stringify(request));
      return true;
    } catch (e) {
      return false;
    }
  },
  
  // Handle incoming replication request
  async handleReplicationRequest(request) {
    const { itemId, item, requestedBy } = request;
    
    // Check if we have capacity
    const mirrorCount = await this.db.mirrors.where('peerId').equals(this.peerId).count();
    if (mirrorCount >= 50) {  // Max 50 mirrors per node
      return { accepted: false, reason: 'capacity_full' };
    }
    
    // Accept and store
    await this.db.mirrors.add({
      itemId,
      peerId: requestedBy,
      h3Ring: this.getH3Distance(this.h3Index, item.h3Index),
      timestamp: Date.now(),
      status: 'active',
      isOwner: false
    });
    
    console.log('[GeoRep] Accepted mirror for:', itemId);
    
    return { accepted: true };
  },
  
  // ============ Erasure Coding ============
  
  // Create erasure coded shards from data
  async createErasureShards(itemId, data, options = {}) {
    const {
      shardCount = this.config.shardCount,
      requiredShards = this.config.requiredShards
    } = options;
    
    // Convert data to binary
    const encoder = new TextEncoder();
    const binary = encoder.encode(JSON.stringify(data));
    
    // Simple erasure coding simulation
    // In production, use proper erasure coding library (backblaze/reed-solomon)
    
    const shards = [];
    const shardSize = Math.ceil(binary.length / shardCount);
    
    for (let i = 0; i < shardCount; i++) {
      const start = i * shardSize;
      const end = Math.min(start + shardSize, binary.length);
      const shardData = binary.slice(start, end);
      
      shards.push({
        shardId: `${itemId}_shard_${i}`,
        index: i,
        data: shardData,
        parity: i >= (shardCount - requiredShards) // Last few are parity
      });
    }
    
    // Store shards locally
    for (const shard of shards) {
      await this.db.shards.put(shard);
    }
    
    console.log('[GeoRep] Created', shards.length, 'shards for:', itemId);
    
    return {
      totalShards: shardCount,
      requiredToReconstruct: requiredShards,
      shards: shards.map(s => s.shardId)
    };
  },
  
  // Reconstruct data from shards
  async reconstructFromShards(itemId) {
    const shards = await this.db.shards
      .where('itemId')
      .equals(itemId)
      .sortBy('index');
    
    if (shards.length < this.config.requiredShards) {
      // Need more shards - request from peers
      await this.requestShardsFromPeers(itemId, this.config.requiredShards - shards.length);
      const updatedShards = await this.db.shards
        .where('itemId')
        .equals(itemId)
        .sortBy('index');
      
      if (updatedShards.length < this.config.requiredShards) {
        throw new Error('Insufficient shards to reconstruct');
      }
    }
    
    // Combine shards
    const binary = new Uint8Array(
      shards.reduce((sum, s) => sum + s.data.length, 0)
    );
    
    let offset = 0;
    for (const shard of shards) {
      binary.set(new Uint8Array(shard.data), offset);
      offset += shard.data.length;
    }
    
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(binary));
  },
  
  // Request missing shards from peers
  async requestShardsFromPeers(itemId, needed) {
    console.log('[GeoRep] Requesting', needed, 'shards for:', itemId);
    // In production, broadcast request to nearby peers
  },
  
  // ============ Mirror Health Check ============
  
  // Start replication loop
  startReplicationLoop() {
    // Periodic replication check
    this.replicationInterval = setInterval(async () => {
      await this.performReplicationCheck();
    }, this.config.replicationInterval);
    
    // Periodic health check
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.mirrorHealthCheck);
  },
  
  // Perform periodic replication check
  async performReplicationCheck() {
    // Check pending items
    const pending = Array.from(this.pendingReplication);
    
    for (const itemId of pending) {
      const mirrors = await this.db.mirrors
        .where('itemId')
        .equals(itemId)
        .toArray();
      
      // If mirrors are healthy, remove from pending
      if (mirrors.length >= this.config.redundancyCount) {
        this.pendingReplication.delete(itemId);
      } else {
        // Re-replicate
        const item = await this.getItem(itemId);
        if (item) {
          await this.replicateItem(item, { force: true });
        }
      }
    }
  },
  
  // Perform health check on mirrors
  async performHealthCheck() {
    const mirrors = await this.db.mirrors.toArray();
    
    // Group by item
    const byItem = mirrors.reduce((acc, m) => {
      if (!acc[m.itemId]) acc[m.itemId] = [];
      acc[m.itemId].push(m);
      return acc;
    }, {});
    
    // Check each item's redundancy
    for (const [itemId, itemMirrors] of Object.entries(byItem)) {
      // Check if mirrors are still responsive
      // In production, ping each mirror
      
      // If any mirror is unresponsive for too long, add to replication queue
      const unresponsive = itemMirrors.filter(m => 
        Date.now() - m.timestamp > this.config.mirrorHealthCheck
      );
      
      if (unresponsive.length > 0) {
        this.pendingReplication.add(itemId);
      }
    }
  },
  
  // Get item (placeholder - would integrate with main store)
  async getItem(itemId) {
    // This would integrate with P2PStore or main database
    return null;
  },
  
  // ============ Public API ============
  
  // Get replication status for an item
  async getReplicationStatus(itemId) {
    const mirrors = await this.db.mirrors
      .where('itemId')
      .equals(itemId)
      .toArray();
    
    const byRing = mirrors.reduce((acc, m) => {
      const ring = m.h3Ring || 0;
      acc[ring] = (acc[ring] || 0) + 1;
      return acc;
    }, {});
    
    return {
      itemId,
      totalMirrors: mirrors.length,
      byRing,
      healthy: mirrors.length >= this.config.redundancyCount,
      needed: Math.max(0, this.config.redundancyCount - mirrors.length)
    };
  },
  
  // Get all mirrored items (from other peers)
  async getMirroredItems() {
    const mirrors = await this.db.mirrors
      .where('isOwner')
      .equals(false)
      .toArray();
    
    const itemIds = [...new Set(mirrors.map(m => m.itemId))];
    return itemIds;
  },
  
  // Get replication stats
  async getStats() {
    const totalMirrors = await this.db.mirrors.count();
    const ownMirrors = await this.db.mirrors
      .where('peerId')
      .equals(this.peerId)
      .count();
    const mirroredItems = await this.getMirroredItems();
    const shards = await this.db.shards.count();
    
    return {
      totalMirrors,
      mirroringForOthers: ownMirrors,
      mirroredFromOthers: mirroredItems.length,
      erasureShards: shards,
      pendingReplication: this.pendingReplication.size
    };
  },
  
  // Stop replication
  stop() {
    if (this.replicationInterval) clearInterval(this.replicationInterval);
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
  }
};

// Export
window.GeoReplicationProtocol = GeoReplicationProtocol;
console.log('[OurBackyard] Geo-Replication Protocol loaded');
