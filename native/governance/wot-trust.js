// Web of Trust (WoT) for OurBackyard
// Trust-based reputation system

const WebOfTrust = {
  // Trust relationships: peerId -> { trustedBy -> level }
  trustGraph: new Map(),
  
  // My trust decisions
  myTrusts: new Map(),  // peerId -> level (-1 to 1)
  
  // Trust levels
  LEVELS: {
    BLOCKED: -1,
    UNTRUSTED: 0,
    NEUTRAL: 0.5,
    TRUSTED: 0.8,
    VERIFIED: 1
  },
  
  // Initialize
  init(peerId) {
    this.myPeerId = peerId;
    console.log('[WoT] Initialized for:', peerId?.substring(0, 8));
    return this;
  },
  
  // Trust a peer directly
  trust(peerId, level = 'TRUSTED') {
    const levelValue = this.LEVELS[level] || 0.5;
    this.myTrusts.set(peerId, levelValue);
    
    // Update graph
    this.updateTrustGraph(this.myPeerId, peerId, levelValue);
    
    console.log('[WoT] Trusted:', peerId?.substring(0, 8), 'as', level);
  },
  
  // Block a peer
  block(peerId) {
    this.trust(peerId, 'BLOCKED');
  },
  
  // Update trust graph
  updateTrustGraph(from, to, level) {
    if (!this.trustGraph.has(to)) {
      this.trustGraph.set(to, new Map());
    }
    
    this.trustGraph.get(to).set(from, level);
  },
  
  // Get trust path (indirect trust through connections)
  getTrustPath(fromPeerId, toPeerId, maxDepth = 3) {
    // BFS to find trust path
    const visited = new Set();
    const queue = [{ peer: fromPeerId, path: [], level: 1 }];
    
    while (queue.length > 0) {
      const { peer, path, level } = queue.shift();
      
      if (peer === toPeerId) {
        return path;
      }
      
      if (level > maxDepth || visited.has(peer)) continue;
      visited.add(peer);
      
      // Get trusted peers
      const trusted = this.trustGraph.get(peer);
      if (trusted) {
        for (const [trustedPeer, trustLevel] of trusted) {
          queue.push({
            peer: trustedPeer,
            path: [...path, { peer: trustedPeer, trustLevel }],
            level: level + 1
          });
        }
      }
    }
    
    return null; // No path found
  },
  
  // Calculate message weight based on trust
  calculateWeight(fromPeerId, baseWeight = 1) {
    let weight = baseWeight;
    
    // Direct trust
    const directTrust = this.myTrusts.get(fromPeerId);
    if (directTrust !== undefined) {
      weight *= (1 + directTrust);
    }
    
    // Indirect trust through trusted peers
    const trustedPeers = Array.from(this.myTrusts.entries())
      .filter(([_, level]) => level >= 0.8)
      .map(([id, _]) => id);
    
    for (const trusted of trustedPeers) {
      const path = this.getTrustPath(trusted, fromPeerId);
      if (path && path.length > 0) {
        // Indirect trust boost
        const pathBonus = 0.1 / path.length;
        weight += pathBonus;
      }
    }
    
    return Math.min(weight, 3); // Cap at 3x
  },
  
  // Should display message from peer
  shouldDisplay(fromPeerId, content) {
    const weight = this.calculateWeight(fromPeerId);
    
    // Blocked peers never display
    const directTrust = this.myTrusts.get(fromPeerId);
    if (directTrust === -1) {
      return { display: false, reason: 'blocked', weight: 0 };
    }
    
    // Low weight = lower priority but still show
    if (weight < 0.3) {
      return { display: true, reason: 'low-trust', weight, priority: 'low' };
    }
    
    return { display: true, reason: 'trusted', weight, priority: weight > 1 ? 'high' : 'normal' };
  },
  
  // Recommend trusted peers
  getRecommendations(limit = 5) {
    const recommendations = [];
    
    // Find peers trusted by people I trust
    const myTrusted = Array.from(this.myTrusts.entries())
      .filter(([_, level]) => level >= 0.8);
    
    for (const [trustedPeer, _] of myTrusted) {
      const theirTrusts = this.trustGraph.get(trustedPeer);
      if (theirTrusts) {
        for (const [peerId, level] of theirTrusts) {
          // Don't recommend people I already know
          if (!this.myTrusts.has(peerId) && peerId !== this.myPeerId) {
            recommendations.push({
              peerId,
              recommendedBy: trustedPeer,
              trustLevel: level
            });
          }
        }
      }
    }
    
    // Sort by trust level and return top N
    recommendations.sort((a, b) => b.trustLevel - a.trustLevel);
    return recommendations.slice(0, limit);
  },
  
  // Export trust list
  exportTrustList() {
    return Array.from(this.myTrusts.entries()).map(([peerId, level]) => ({
      peerId,
      level,
      label: Object.entries(this.LEVELS).find(([_, v]) => v === level)?.[0] || 'UNKNOWN'
    }));
  },
  
  // Import trust list
  importTrustList(list) {
    for (const { peerId, level } of list) {
      this.myTrusts.set(peerId, level);
      this.updateTrustGraph(this.myPeerId, peerId, level);
    }
    console.log('[WoT] Imported', list.length, 'trust relationships');
  },
  
  // Get stats
  getStats() {
    let trusted = 0, blocked = 0, neutral = 0;
    
    for (const level of this.myTrusts.values()) {
      if (level < 0) blocked++;
      else if (level > 0.6) trusted++;
      else neutral++;
    }
    
    return {
      total: this.myTrusts.size,
      trusted,
      blocked,
      neutral,
      graphNodes: this.trustGraph.size
    };
  }
};

// Export
window.WebOfTrust = WebOfTrust;
console.log('[OurBackyard] Web of Trust loaded');
