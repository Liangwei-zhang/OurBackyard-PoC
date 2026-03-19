// Reputation-based Resource Quota System
// Incentivizes node contribution with priority access

const ResourceQuota = {
  config: {
    baseQuota: 100,      // Messages per hour
    storageBonus: 10,     // Per MB stored
    bandwidthBonus: 5,     // Per MB relayed
    trustWeight: 0.5      // WoT impact multiplier
  },
  
  // Get quota for peer
  async getQuota(peerId) {
    const contribution = await this.getContribution(peerId);
    const trust = await this.getTrustScore(peerId);
    
    // Calculate quota
    const storageBonus = contribution.storageMB * this.config.storageBonus;
    const bandwidthBonus = contribution.bandwidthMB * this.config.bandwidthBonus;
    const trustBonus = trust * this.config.trustWeight;
    
    const quota = {
      messagesPerHour: Math.round(this.config.baseQuota + storageBonus + bandwidthBonus + trustBonus),
      storageMB: contribution.storageMB + Math.round(trust * 10),
      bandwidthMB: contribution.bandwidthMB + Math.round(trust * 5),
      priorityLevel: trust > 0.8 ? 'high' : trust > 0.5 ? 'normal' : 'low'
    };
    
    return quota;
  },
  
  // Record contribution
  async recordContribution(peerId, type, amount) {
    const key = `contrib_${peerId}`;
    let contrib = { storageMB: 0, bandwidthMB: 0, lastUpdate: Date.now() };
    
    try {
      const saved = localStorage.getItem(key);
      if (saved) contrib = JSON.parse(saved);
    } catch (e) {}
    
    if (type === 'storage') contrib.storageMB += amount;
    if (type === 'bandwidth') contrib.bandwidthMB += amount;
    contrib.lastUpdate = Date.now();
    
    localStorage.setItem(key, JSON.stringify(contrib));
    console.log('[Quota] Recorded', type, amount, 'for', peerId?.substring(0, 8));
  },
  
  // Get contribution stats
  async getContribution(peerId) {
    const key = `contrib_${peerId}`;
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : { storageMB: 0, bandwidthMB: 0 };
    } catch (e) {
      return { storageMB: 0, bandwidthMB: 0 };
    }
  },
  
  // Get trust score
  async getTrustScore(peerId) {
    // Would integrate with ZK Reputation
    return 0.5; // Default neutral
  },
  
  // Check if action allowed
  async canPerform(peerId, action) {
    const quota = await this.getQuota(peerId);
    const usage = await this.getUsage(peerId, action);
    
    return usage < quota.messagesPerHour;
  },
  
  // Get usage
  async getUsage(peerId, action) {
    const key = `usage_${action}_${peerId}`;
    const hour = Math.floor(Date.now() / 3600000);
    
    try {
      const saved = localStorage.getItem(key);
      if (!saved) return 0;
      
      const data = JSON.parse(saved);
      if (data.hour !== hour) return 0;
      
      return data.count || 0;
    } catch (e) {
      return 0;
    }
  },
  
  // Record action usage
  async recordAction(peerId, action) {
    const key = `usage_${action}_${peerId}`;
    const hour = Math.floor(Date.now() / 3600000);
    
    let data = { hour, count: 0 };
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.hour === hour) data = parsed;
      }
    } catch (e) {}
    
    data.count++;
    localStorage.setItem(key, JSON.stringify(data));
  }
};

window.ResourceQuota = ResourceQuota;
console.log('[OurBackyard] Resource Quota loaded');
