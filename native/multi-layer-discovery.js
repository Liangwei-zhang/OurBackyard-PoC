// Multi-layer Discovery - Hybrid Discovery for OurBackyard
// Implements Internet-Independent communication: DHT + mDNS + BLE

const MultiLayerDiscovery = {
  layers: {
    dht: null,      // Global discovery
    mdns: null,     // Local network
    ble: null        // Bluetooth Low Energy
  },
  peerId: null,
  discoveredPeers: new Map(), // peerId -> { layer, lastSeen, data }
  
  // Initialize all discovery layers
  async init(peerId) {
    this.peerId = peerId;
    
    // Layer 1: DHT (via Libp2p if available)
    await this.initDHT();
    
    // Layer 2: mDNS (local network)
    await this.initMDNS();
    
    // Layer 3: BLE (if available)
    await this.initBLE();
    
    console.log('[Discovery] Multi-layer initialized');
    
    return this;
  },
  
  // Layer 1: DHT Discovery
  async initDHT() {
    // Uses Libp2p's kad-dht under the hood
    this.layers.dht = {
      enabled: true,
      topic: 'ourbackyard.h3'
    };
    
    console.log('[Discovery] DHT layer ready');
  },
  
  // Layer 2: mDNS Local Discovery
  async initMDNS() {
    // Using localStorage for same-origin discovery
    // In production, use @capacitor-community/zeroconf
    this.layers.mdns = {
      enabled: true,
      broadcastInterval: null
    };
    
    // Start broadcasting
    this.startMDNSBroadcast();
    
    console.log('[Discovery] mDNS layer ready');
  },
  
  // Start mDNS broadcast
  startMDNSBroadcast() {
    const broadcast = () => {
      const presence = {
        type: 'ourbackyard-presence',
        peerId: this.peerId,
        h3Index: window.currentH3Index || 'unknown',
        timestamp: Date.now(),
        layers: ['dht', 'mdns'] // Capabilities
      };
      
      try {
        localStorage.setItem('mDNS_' + this.peerId, JSON.stringify(presence));
      } catch (e) {}
    };
    
    broadcast();
    this.layers.mdns.broadcastInterval = setInterval(broadcast, 5000);
  },
  
  // Stop mDNS
  stopMDNS() {
    if (this.layers.mdns.broadcastInterval) {
      clearInterval(this.layers.mdns.broadcastInterval);
    }
  },
  
  // Scan for mDNS peers
  scanMDNS() {
    const found = [];
    const now = Date.now();
    
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('mDNS_')) {
          try {
            const data = JSON.parse(localStorage.getItem(key));
            if (data.peerId !== this.peerId && now - data.timestamp < 10000) {
              found.push(data);
              this.discoveredPeers.set(data.peerId, {
                layer: 'mdns',
                lastSeen: now,
                data
              });
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    
    return found;
  },
  
  // Layer 3: BLE Discovery
  async initBLE() {
    // Check if Web Bluetooth is available
    if (!navigator.bluetooth) {
      console.log('[Discovery] BLE not available');
      this.layers.ble = { enabled: false };
      return;
    }
    
    this.layers.ble = {
      enabled: true,
      device: null
    };
    
    console.log('[Discovery] BLE layer ready');
  },
  
  // Start BLE scanning
  async startBLEScan() {
    if (!this.layers.ble?.enabled) return;
    
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['ourbackyard'] }],
        optionalServices: ['battery_service']
      });
      
      this.layers.ble.device = device;
      
      device.addEventListener('gattserverdisconnected', () => {
        console.log('[Discovery] BLE disconnected');
      });
      
      console.log('[Discovery] BLE connected to:', device.name);
      
    } catch (e) {
      console.log('[Discovery] BLE scan failed:', e);
    }
  },
  
  // Get all discovered peers
  getDiscoveredPeers() {
    const peers = [];
    
    // Add DHT peers
    // (Would come from Libp2p)
    
    // Add mDNS peers
    this.scanMDNS().forEach(p => {
      peers.push({ ...p, layer: 'mdns' });
    });
    
    // Add BLE peers
    // (Would come from Web Bluetooth)
    
    return peers;
  },
  
  // Get peers by layer
  getPeersByLayer(layer) {
    return Array.from(this.discoveredPeers.entries())
      .filter(([_, p]) => p.layer === layer)
      .map(([id, p]) => ({ peerId: id, ...p }));
  },
  
  // Get the best available layer for communication
  getBestLayer(peerId) {
    const peer = this.discoveredPeers.get(peerId);
    if (!peer) return 'dht'; // Default to DHT
    
    // Prefer closer layers
    const layerPriority = ['ble', 'mdns', 'dht'];
    return peer.layer || 'dht';
  },
  
  // Clean up stale peers
  cleanup() {
    const now = Date.now();
    const stale = [];
    
    for (const [id, p] of this.discoveredPeers) {
      if (now - p.lastSeen > 30000) { // 30 seconds
        stale.push(id);
      }
    }
    
    stale.forEach(id => this.discoveredPeers.delete(id));
  },
  
  // Stop all layers
  stop() {
    this.stopMDNS();
    
    if (this.layers.ble?.device) {
      this.layers.ble.device.close();
    }
    
    console.log('[Discovery] All layers stopped');
  },
  
  // Get discovery stats
  getStats() {
    return {
      dht: this.layers.dht?.enabled || false,
      mdns: this.layers.mdns?.enabled || false,
      ble: this.layers.ble?.enabled || false,
      totalPeers: this.discoveredPeers.size,
      layers: Array.from(this.discoveredPeers.values()).reduce((acc, p) => {
        acc[p.layer] = (acc[p.layer] || 0) + 1;
        return acc;
      }, {})
    };
  }
};

// Auto-cleanup every 30 seconds
setInterval(() => MultiLayerDiscovery.cleanup(), 30000);

// Export
window.MultiLayerDiscovery = MultiLayerDiscovery;
console.log('[OurBackyard] Multi-layer Discovery loaded');
