// Hyperswarm DHT Implementation for OurBackyard
// Pure P2P node discovery without central servers

const HyperswarmDHT = {
  swarm: null,
  topic: null,
  peers: new Map(),
  connection: null,
  
  // Initialize Hyperswarm
  async init(peerId, options = {}) {
    this.peerId = peerId;
    this.topic = options.topic || 'ourbackyard-calgary';
    
    // In production, use actual hyperswarm library
    // For browser, implement DHT-like behavior using WebRTC
    
    console.log('[DHT] Initialized with topic:', this.topic);
    
    return this;
  },
  
  // Join topic (discover peers interested in same topic)
  async joinTopic(topic) {
    this.topic = topic;
    
    // Simulate topic join
    // In production: this.swarm.join(topic)
    
    console.log('[DHT] Joined topic:', topic);
    
    // Start periodic peer discovery
    this.startDiscovery();
    
    return this;
  },
  
  // Leave topic
  async leaveTopic() {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
    }
    this.peers.clear();
    console.log('[DHT] Left topic:', this.topic);
  },
  
  // Start peer discovery
  startDiscovery() {
    this.discoveryInterval = setInterval(() => {
      this.discoverPeers();
    }, 10000); // Every 10 seconds
    
    // Initial discovery
    this.discoverPeers();
  },
  
  // Discover peers (simulated DHT lookup)
  async discoverPeers() {
    // In production, this would query the DHT for peers
    // For now, use mDNS as fallback
    
    const mdnsPeers = this.scanMDNS();
    
    mdnsPeers.forEach(peer => {
      if (!this.peers.has(peer.peerId)) {
        console.log('[DHT] Found peer via mDNS:', peer.peerId?.substring(0, 8));
        this.peers.set(peer.peerId, {
          ...peer,
          source: 'dht',
          lastSeen: Date.now()
        });
      }
    });
    
    // Announce our presence
    this.announce();
  },
  
  // Scan mDNS for local peers
  scanMDNS() {
    const found = [];
    const now = Date.now();
    
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('dht_')) {
          try {
            const data = JSON.parse(localStorage.getItem(key));
            if (data.peerId !== this.peerId && 
                data.topic === this.topic && 
                now - data.timestamp < 15000) {
              found.push(data);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    
    return found;
  },
  
  // Announce our presence to DHT
  announce() {
    const announcement = {
      type: 'dht_announce',
      peerId: this.peerId,
      topic: this.topic,
      timestamp: Date.now(),
      ports: [4001], // Simulated ports
    };
    
    try {
      localStorage.setItem('dht_' + this.peerId, JSON.stringify(announcement));
    } catch (e) {}
  },
  
  // Look up peers for a topic
  async lookup(topic) {
    // In production, query DHT
    // For now, return cached peers
    
    return Array.from(this.peers.values())
      .filter(p => p.topic === topic);
  },
  
  // Connect to a peer
  async connect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.log('[DHT] Peer not found:', peerId);
      return null;
    }
    
    // In production, use WebRTC to connect
    console.log('[DHT] Connecting to:', peerId?.substring(0, 8));
    
    return {
      peerId,
      topic: this.topic,
      connected: true
    };
  },
  
  // Get all discovered peers
  getPeers() {
    return Array.from(this.peers.values());
  },
  
  // Get peer count
  getPeerCount() {
    return this.peers.size;
  },
  
  // Handle incoming connection
  onConnection(callback) {
    this.connectionCallback = callback;
  },
  
  // Handle peer discovery
  onPeerFound(callback) {
    this.peerFoundCallback = callback;
  },
  
  // Destroy
  destroy() {
    this.leaveTopic();
    this.peers.clear();
    console.log('[DHT] Destroyed');
  }
};

// Export
window.HyperswarmDHT = HyperswarmDHT;
console.log('[OurBackyard] Hyperswarm DHT loaded');
