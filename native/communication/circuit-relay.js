// Circuit Relay V2 for OurBackyard
// Enables peer connections through relay nodes when direct connection fails

const CircuitRelayV2 = {
  relays: new Map(),  // available relay nodes
  maxHops: 3,       // max relay hops
  
  // Initialize
  async init(peerId) {
    this.peerId = peerId;
    console.log('[Relay] Circuit Relay V2 initialized');
    return this;
  },
  
  // Discover relay nodes
  async discoverRelays() {
    const relays = [];
    
    // Scan for relay announcements
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('relay_')) {
          try {
            const relay = JSON.parse(localStorage.getItem(key));
            if (relay.peerId !== this.peerId && relay.available) {
              relays.push(relay);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    
    // Store available relays
    this.relays.clear();
    for (const relay of relays) {
      this.relays.set(relay.peerId, relay);
    }
    
    console.log('[Relay] Found', relays.length, 'relays');
    return relays;
  },
  
  // Announce as relay node
  async announceAsRelay(capabilities = {}) {
    const announcement = {
      type: 'relay_announce',
      peerId: this.peerId,
      available: true,
      bandwidth: capabilities.bandwidth || 'medium',
      latency: capabilities.latency || 50,
      timestamp: Date.now()
    };
    
    try {
      localStorage.setItem('relay_' + this.peerId, JSON.stringify(announcement));
    } catch (e) {}
    
    console.log('[Relay] Announced as relay node');
  },
  
  // Request relay connection
  async requestRelayConnection(targetPeerId) {
    // Find best relay
    const relays = Array.from(this.relays.values());
    if (relays.length === 0) {
      await this.discoverRelays();
    }
    
    if (this.relays.size === 0) {
      return { success: false, reason: 'no_relays_available' };
    }
    
    // Select best relay (lowest latency)
    const bestRelay = relays.sort((a, b) => a.latency - b.latency)[0];
    
    console.log('[Relay] Requesting connection via:', bestRelay.peerId?.substring(0, 8));
    
    // In production, would send actual relay request
    return {
      success: true,
      relayPeerId: bestRelay.peerId,
      hop: 1,
      path: [this.peerId, bestRelay.peerId, targetPeerId]
    };
  },
  
  // Establish circuit
  async establishCircuit(targetPeerId) {
    // Try direct first
    const direct = await this.tryDirectConnection(targetPeerId);
    if (direct.success) {
      return { ...direct, method: 'direct' };
    }
    
    // Try via relay
    const viaRelay = await this.requestRelayConnection(targetPeerId);
    if (viaRelay.success) {
      return { ...viaRelay, method: 'relay' };
    }
    
    // Try multi-hop
    const multiHop = await this.tryMultiHop(targetPeerId);
    return { ...multiHop, method: 'multihop' };
  },
  
  // Try direct connection
  async tryDirectConnection(targetPeerId) {
    // In production, would attempt WebRTC connection
    return { success: false, reason: 'connection_failed' };
  },
  
  // Try multi-hop
  async tryMultiHop(targetPeerId) {
    // Find path through relays
    const visited = new Set([this.peerId]);
    const path = [this.peerId];
    
    for (let hop = 0; hop < this.maxHops; hop++) {
      // Find relay not in path
      const available = Array.from(this.relays.values())
        .filter(r => !visited.has(r.peerId));
      
      if (available.length === 0) break;
      
      const next = available[0];
      visited.add(next.peerId);
      path.push(next.peerId);
    }
    
    path.push(targetPeerId);
    
    return {
      success: path.length > 2,
      path,
      hops: path.length - 1
    };
  }
};

// Export
window.CircuitRelayV2 = CircuitRelayV2;
console.log('[OurBackyard] Circuit Relay V2 loaded');
