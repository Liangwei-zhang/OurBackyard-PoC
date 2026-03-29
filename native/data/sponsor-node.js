// Sponsor Node - Distributed Redundant Storage for OurBackyard
// Implements "neighbor backup" logic for data persistence

const SponsorNode = {
  db: null,
  peerId: null,
  sponsors: new Map(), // peerId -> { lastSeen,信任 score }
  replicationInterval: null,
  
  // Initialize sponsor node
  async init(peerId) {
    this.peerId = peerId;
    
    // Open IndexedDB for mirror storage
    this.db = new Dexie('SponsorNodeDB');
    this.db.version(1).stores({
      mirrors: '++id, ownerPeerId, itemId, data, timestamp, synced',
      reputation: 'peerId'
    });
    
    console.log('[Sponsor] Initialized for:', peerId?.substring(0, 8));
    
    // Start replication loop
    this.startReplication();
    
    return this;
  },
  
  // Store data and create mirrors on sponsor nodes
  async storeWithMirrors(data, itemId) {
    const timestamp = Date.now();
    
    // Store locally first
    await this.db.mirrors.add({
      ownerPeerId: this.peerId,
      itemId: itemId,
      data: JSON.stringify(data),
      timestamp: timestamp,
      synced: false
    });
    
    // Find sponsor candidates (neighboring peers with high trust)
    const sponsors = await this.findSponsorCandidates();
    
    console.log('[Sponsor] Found', sponsors.length, 'sponsor candidates');
    
    // Request mirrors from sponsors
    for (const sponsor of sponsors) {
      await this.requestMirror(sponsor, { itemId, data, timestamp });
    }
    
    return { local: true, mirrors: sponsors.length };
  },
  
  // Find sponsor candidates (neighbors with good reputation)
  async findSponsorCandidates() {
    const reps = await this.db.reputation.toArray();
    
    // Sort by trust score
    reps.sort((a, b) => b.trustScore - a.trustScore);
    
    // Return top 3 candidates
    return reps.slice(0, 3).map(r => r.peerId);
  },
  
  // Request a sponsor to mirror our data
  async requestMirror(sponsorPeerId, payload) {
    // In a real implementation, this would send via Libp2p
    // For now, we simulate the request
    console.log('[Sponsor] Requesting mirror from:', sponsorPeerId?.substring(0, 8));
    
    // Emit event for P2P layer to handle
    if (window.SponsorNodeEvents) {
      window.SponsorNodeEvents.emit('requestMirror', { sponsorPeerId, payload });
    }
  },
  
  // Handle incoming mirror request from another peer
  async handleMirrorRequest(fromPeerId, payload) {
    const { itemId, data, timestamp } = payload;
    
    // Store the mirrored data
    await this.db.mirrors.add({
      ownerPeerId: fromPeerId,
      itemId: itemId,
      data: JSON.stringify(data),
      timestamp: timestamp,
      synced: true,
      mirroredFrom: fromPeerId
    });
    
    // Update sponsor reputation
    await this.updateTrustScore(fromPeerId, +1);
    
    console.log('[Sponsor] Mirrored data from:', fromPeerId?.substring(0, 8));
  },
  
  // Retrieve mirrored data when owner is offline
  async retrieveMirrored(itemId) {
    const mirrors = await this.db.mirrors
      .where('itemId')
      .equals(itemId)
      .toArray();
    
    if (mirrors.length > 0) {
      console.log('[Sponsor] Found', mirrors.length, 'mirrors for:', itemId);
      return mirrors.map(m => JSON.parse(m.data));
    }
    
    return [];
  },
  
  // Get all mirrored data for a peer
  async getMirroredData(peerId) {
    const mirrors = await this.db.mirrors
      .where('ownerPeerId')
      .equals(peerId)
      .toArray();
    
    return mirrors.map(m => ({
      itemId: m.itemId,
      data: JSON.parse(m.data),
      timestamp: m.timestamp,
      mirrored: m.synced
    }));
  },
  
  // Update trust score for a peer
  async updateTrustScore(peerId, delta) {
    const existing = await this.db.reputation.get(peerId);
    
    if (existing) {
      await this.db.reputation.update(peerId, {
        trustScore: Math.max(0, existing.trustScore + delta),
        lastSeen: Date.now()
      });
    } else {
      await this.db.reputation.add({
        peerId: peerId,
        trustScore: Math.max(0, 10 + delta),
        lastSeen: Date.now(),
        mirrorsStored: 0
      });
    }
  },
  
  // Start replication loop
  startReplication() {
    // Replicate every 5 minutes
    this.replicationInterval = setInterval(async () => {
      await this.replicatePending();
    }, 5 * 60 * 1000);
  },
  
  // Replicate pending items to sponsors
  async replicatePending() {
    // Use .filter() — IndexedDB cannot use boolean values as index keys (.equals(false) throws)
    const pending = await this.db.mirrors
      .filter(r => !r.synced)
      .toArray();
    
    for (const item of pending) {
      const sponsors = await this.findSponsorCandidates();
      
      for (const sponsor of sponsors) {
        await this.requestMirror(sponsor, {
          itemId: item.itemId,
          data: JSON.parse(item.data),
          timestamp: item.timestamp
        });
      }
      
      // Mark as attempted
      await this.db.mirrors.update(item.id, { synced: true });
    }
  },
  
  // Stop replication
  stop() {
    if (this.replicationInterval) {
      clearInterval(this.replicationInterval);
    }
  },
  
  // Get storage stats
  async getStats() {
    const totalMirrors = await this.db.mirrors.count();
    const ownMirrors = await this.db.mirrors
      .where('ownerPeerId')
      .equals(this.peerId)
      .count();
    const sponsorsCount = await this.db.reputation.count();
    
    return {
      totalMirrors,
      ownMirrors,
      sponsorsCount,
      storageUsed: totalMirrors * 2 // Approximate KB
    };
  }
};

// Export
window.SponsorNode = SponsorNode;
console.log('[OurBackyard] Sponsor Node loaded');
