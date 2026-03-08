// Adaptive Redundancy for Erasure Coding
// Dynamically adjusts redundancy based on network conditions

const AdaptiveRedundancy = {
  config: {
    baseShards: 10,
    minRequired: 3,
    maxShards: 20,
    // Network thresholds
    highConnectivityThreshold: 10, // peers online
    lowConnectivityThreshold: 3,
    // Adjustments
    highConnectivityShards: 6,
    lowConnectivityShards: 4
  },
  
  // Get current redundancy settings
  async calculateRedundancy(options = {}) {
    const {
      peerCount = 0,
      itemImportance = 'normal', // low, normal, high, critical
      networkStability = 'stable' // unstable, stable
    } = options;
    
    let shards = this.config.baseShards;
    let required = this.config.minRequired;
    
    // Adjust based on peer count
    if (peerCount >= this.config.highConnectivityThreshold) {
      // Many peers online - can reduce redundancy
      shards = this.config.highConnectivityShards;
      required = Math.ceil(shards * 0.3);
    } else if (peerCount < this.config.lowConnectivityThreshold) {
      // Few peers online - increase redundancy
      shards = this.config.maxShards;
      required = Math.ceil(shards * 0.2);
    }
    
    // Adjust based on importance
    switch (itemImportance) {
      case 'critical':
        shards = Math.min(shards + 5, this.config.maxShards);
        required = Math.ceil(shards * 0.15);
        break;
      case 'high':
        shards = Math.min(shards + 2, this.config.maxShards);
        break;
      case 'low':
        shards = Math.max(shards - 3, this.config.minRequired + 1);
        break;
    }
    
    // Adjust based on network stability
    if (networkStability === 'unstable') {
      shards = Math.min(shards + 3, this.config.maxShards);
      required = Math.ceil(shards * 0.15);
    }
    
    return {
      totalShards: shards,
      requiredToReconstruct: required,
      redundancyRatio: (shards / required).toFixed(1),
      reason: this.getReason({ peerCount, itemImportance, networkStability })
    };
  },
  
  // Get reason string
  getReason({ peerCount, itemImportance, networkStability }) {
    const reasons = [];
    
    if (peerCount >= 10) reasons.push('high_peers');
    else if (peerCount < 3) reasons.push('low_peers');
    
    if (itemImportance !== 'normal') reasons.push(itemImportance + '_importance');
    if (networkStability === 'unstable') reasons.push('unstable_network');
    
    return reasons.join(', ') || 'normal';
  },
  
  // Monitor network and adjust
  async monitorAndAdjust(itemId, currentSettings) {
    // In production, would monitor actual network conditions
    const peerCount = await this.estimatePeerCount();
    const networkStability = await this.estimateNetworkStability();
    
    const newSettings = await this.calculateRedundancy({
      peerCount,
      itemImportance: currentSettings.importance,
      networkStability
    });
    
    // If significant change, re-encode
    if (newSettings.totalShards !== currentSettings.totalShards) {
      console.log('[Adaptive] Redundancy changed:', 
        currentSettings.totalShards, '->', newSettings.totalShards);
      return { shouldReencode: true, newSettings };
    }
    
    return { shouldReencode: false, newSettings };
  },
  
  // Estimate peer count
  async estimatePeerCount() {
    // Would integrate with discovery layer
    try {
      let count = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('mDNS_') || key.startsWith('dht_'))) {
          count++;
        }
      }
      return count;
    } catch (e) {
      return 5; // default
    }
  },
  
  // Estimate network stability
  async estimateNetworkStability() {
    // Check recent connection failures
    const recent = localStorage.getItem('connection_failures');
    if (!recent) return 'stable';
    
    try {
      const failures = JSON.parse(recent);
      const recentFailures = failures.filter(f => Date.now() - f < 60000);
      
      if (recentFailures.length > 5) return 'unstable';
      if (recentFailures.length > 2) return 'marginal';
      return 'stable';
    } catch (e) {
      return 'stable';
    }
  },
  
  // Record connection failure
  recordFailure() {
    const recent = localStorage.getItem('connection_failures');
    let failures = [];
    
    if (recent) {
      try {
        failures = JSON.parse(recent);
      } catch (e) {}
    }
    
    failures.push(Date.now());
    
    // Keep only last 100
    failures = failures.slice(-100);
    
    localStorage.setItem('connection_failures', JSON.stringify(failures));
  },
  
  // Get optimal strategy
  async getOptimalStrategy() {
    const peerCount = await this.estimatePeerCount();
    const stability = await this.estimateNetworkStability();
    
    const normal = await this.calculateRedundancy({
      peerCount,
      itemImportance: 'normal',
      networkStability: stability
    });
    
    const critical = await this.calculateRedundancy({
      peerCount,
      itemImportance: 'critical',
      networkStability: stability
    });
    
    return { normal, critical };
  }
};

// Export
window.AdaptiveRedundancy = AdaptiveRedundancy;
console.log('[OurBackyard] Adaptive Redundancy loaded');
