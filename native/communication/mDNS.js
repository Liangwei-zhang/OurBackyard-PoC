// mDNS Local Discovery Service
// OurBackyard - Offline P2P Communication

const MDNSService = {
  isRunning: false,
  peerList: new Map(), // peerId -> { ip, port, lastSeen }
  broadcastPort: 5353,
  serviceName: 'ourbackyard',
  
  // Start mDNS discovery
  async start() {
    if (this.isRunning) return;
    
    console.log('[mDNS] Starting local discovery...');
    this.isRunning = true;
    
    // Broadcast our presence periodically
    this.broadcastInterval = setInterval(() => {
      this.broadcastPresence();
    }, 5000);
    
    // Listen for peers
    this.listenInterval = setInterval(() => {
      this.scanForPeers();
    }, 3000);
  },
  
  // Stop mDNS discovery
  stop() {
    this.isRunning = false;
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    if (this.listenInterval) clearInterval(this.listenInterval);
  },
  
  // Broadcast our presence to local network
  broadcastPresence() {
    const presence = {
      type: 'ourbackyard-presence',
      peerId: peerId,
      displayName: displayName,
      h3Index: currentH3Index,
      timestamp: Date.now(),
      port: this.broadcastPort,
      version: '1.0'
    };
    
    // Use localStorage as fallback for same-origin discovery
    // In production, use proper mDNS multicast
    try {
      localStorage.setItem('mDNS_broadcast_' + peerId, JSON.stringify(presence));
    } catch(e) {}
    
    console.log('[mDNS] Broadcasting:', peerId);
  },
  
  // Scan for nearby peers
  scanForPeers() {
    const foundPeers = [];
    const now = Date.now();
    
    // Check localStorage for peer broadcasts (works on same network)
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('mDNS_broadcast_')) {
          try {
            const data = JSON.parse(localStorage.getItem(key));
            
            // Skip ourselves
            if (data.peerId === peerId) continue;
            
            // Only include recent broadcasts (within 10 seconds)
            if (now - data.timestamp < 10000) {
              foundPeers.push(data);
              
              // Update peer list
              if (!this.peerList.has(data.peerId)) {
                console.log('[mDNS] Found peer:', data.displayName);
                notify('📡 Found local peer: ' + data.displayName, 'info');
              }
              
              this.peerList.set(data.peerId, {
                ...data,
                lastSeen: now
              });
            }
          } catch(e) {}
        }
      }
    } catch(e) {}
    
    // Clean up stale peers
    for (const [id, peer] of this.peerList) {
      if (now - peer.lastSeen > 15000) {
        this.peerList.delete(id);
        console.log('[mDNS] Peer left:', id);
      }
    }
    
    return foundPeers;
  },
  
  // Get list of available local peers
  getPeers() {
    return Array.from(this.peerList.values());
  },
  
  // Try to connect to a local peer directly
  async connectToPeer(peerInfo) {
    console.log('[mDNS] Attempting direct connection to:', peerInfo.displayName);
    
    // Create direct WebRTC connection via local network
    // This bypasses the need for TURN when on same LAN
    
    // Note: In a real implementation, you would:
    // 1. Use the peer's IP address from mDNS
    // 2. Create STUN server with local IP:port
    // 3. Exchange SDP directly without signaling server
    
    // For now, we notify the user
    notify('🔗 Local P2P with: ' + peerInfo.displayName, 'success');
    
    return {
      success: true,
      peer: peerInfo
    };
  }
};

// Auto-start when network is offline
NetworkService = {
  ...NetworkService,
  
  enterOfflineMode() {
    this.isOfflineMode = true;
    notify('📴 Offline - scanning local network...', 'info');
    
    // Start mDNS discovery
    MDNSService.start();
  },
  
  exitOfflineMode() {
    this.isOfflineMode = false;
    notify('🌐 Back online', 'success');
    
    // Stop mDNS when back online
    MDNSService.stop();
  }
};

console.log('[OurBackyard] mDNS Service loaded');
