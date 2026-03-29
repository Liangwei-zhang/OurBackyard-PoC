// BLE + Wi-Fi Direct Discovery for OurBackyard
// Internet-independent device-to-device communication

const BLEDiscovery = {
  device: null,
  server: null,
  characteristic: null,
  peers: new Map(),
  advertising: false,
  scanning: false,
  
  // Initialize BLE
  async init() {
    // Check Web Bluetooth availability
    if (!navigator.bluetooth) {
      console.log('[BLE] Web Bluetooth not available');
      this.available = false;
      return this;
    }
    
    this.available = true;
    console.log('[BLE] Initialized');
    
    return this;
  },
  
  // Check if BLE is available
  isAvailable() {
    return this.available && navigator.bluetooth !== undefined;
  },
  
  // Start advertising (as peripheral)
  async startAdvertising(peerId, data = {}) {
    if (!this.isAvailable()) {
      console.log('[BLE] BLE not available');
      return false;
    }
    
    try {
      // Request Bluetooth device to act as peripheral
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['0000feda-0000-1000-8000-00805f9b34fb'] }],
        optionalServices: ['battery_service', 'generic_access']
      });
      
      // Connect to GATT server
      this.server = await this.device.gatt.connect();
      
      // Create custom service
      this.bleService = await this.server.getPrimaryService('0000feda-0000-1000-8000-00805f9b34fb');
      
      // Create characteristics for data exchange
      const peerIdChar = await this.bleService.getCharacteristic('0000fedb-0000-1000-8000-00805f9b34fb');
      const dataChar = await this.bleService.getCharacteristic('0000fedc-0000-1000-8000-00805f9b34fb');
      
      // Write our peer ID
      const encoder = new TextEncoder();
      await peerIdChar.writeValue(encoder.encode(JSON.stringify({
        peerId: peerId,
        ...data
      })));
      
      this.advertising = true;
      console.log('[BLE] Started advertising');
      
      // Handle disconnect
      this.device.addEventListener('gattserverdisconnected', () => {
        console.log('[BLE] Disconnected');
        this.advertising = false;
      });
      
      return true;
      
    } catch (e) {
      console.log('[BLE] Advertising failed:', e);
      return false;
    }
  },
  
  // Stop advertising
  stopAdvertising() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.advertising = false;
    console.log('[BLE] Stopped advertising');
  },
  
  // Start scanning (as central)
  async startScanning() {
    if (!this.isAvailable()) {
      console.log('[BLE] BLE not available for scanning');
      return [];
    }
    
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['0000feda-0000-1000-8000-00805f9b34fb'] }],
        optionalServices: ['battery_service']
      });
      
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService('0000feda-0000-1000-8000-00805f9b34fb');
      
      // Read peer ID
      const peerIdChar = await service.getCharacteristic('0000fedb-0000-1000-8000-00805f9b34fb');
      const value = await peerIdChar.readValue();
      const decoder = new TextDecoder();
      const data = JSON.parse(decoder.decode(value));
      
      this.peers.set(data.peerId, {
        ...data,
        device,
        lastSeen: Date.now(),
        source: 'ble'
      });
      
      console.log('[BLE] Found peer:', data.peerId?.substring(0, 8));
      
      // Auto-disconnect after read
      device.gatt.disconnect();
      
      return Array.from(this.peers.values());
      
    } catch (e) {
      console.log('[BLE] Scanning failed:', e);
      return [];
    }
  },
  
  // Connect to a BLE peer
  async connect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.device) {
      return null;
    }
    
    try {
      const server = await peer.device.gatt.connect();
      const service = await server.getPrimaryService('0000feda-0000-1000-8000-00805f9b34fb');
      const dataChar = await service.getCharacteristic('0000fedc-0000-1000-8000-00805f9b34fb');
      
      // Send data
      const encoder = new TextEncoder();
      await dataChar.writeValue(encoder.encode(JSON.stringify({
        type: 'connect',
        from: this.peerId
      })));
      
      console.log('[BLE] Connected to:', peerId?.substring(0, 8));
      
      return { connected: true, service };
      
    } catch (e) {
      console.log('[BLE] Connection failed:', e);
      return null;
    }
  },
  
  // Get found peers
  getPeers() {
    return Array.from(this.peers.values());
  },
  
  // Cleanup
  destroy() {
    this.stopAdvertising();
    this.peers.clear();
  }
};

// Wi-Fi Direct P2P
const WiFiDirect = {
  available: false,
  connection: null,
  peers: new Map(),
  
  // Check availability (requires native plugin)
  async checkAvailability() {
    // In production, use @capacitor-community/wifi-direct
    // For web, check if APIs available
    
    if (navigator.wifiDirect) {
      this.available = true;
    }
    
    console.log('[WiFi Direct] Available:', this.available);
    return this.available;
  },
  
  // Discover peers
  async discoverPeers() {
    if (!this.available) {
      return [];
    }
    
    // In production, use native Wi-Fi Direct APIs
    console.log('[WiFi Direct] Discovering peers...');
    
    return [];
  },
  
  // Connect to peer
  async connect(peerId) {
    if (!this.available) {
      return null;
    }
    
    console.log('[WiFi Direct] Connecting to:', peerId);
    
    return { connected: true, peerId };
  },
  
  // Create group (act as AP)
  async createGroup() {
    if (!this.available) {
      return null;
    }
    
    console.log('[WiFi Direct] Creating group...');
    
    return {
      ssid: 'OurBackyard_P2P',
      password: crypto.randomUUID().substring(0, 8),
      frequency: 5 // 5GHz
    };
  },
  
  // Get peers
  getPeers() {
    return Array.from(this.peers.values());
  }
};

// Unified Device Discovery
const DeviceDiscovery = {
  ble: BLEDiscovery,
  wifi: WiFiDirect,
  mdns: null,
  
  async init(peerId) {
    await this.ble.init();
    await this.wifi.checkAvailability();
    
    // Load mDNS
    if (window.MultiLayerDiscovery) {
      this.mdns = window.MultiLayerDiscovery;
    }
    
    console.log('[DeviceDiscovery] Initialized');
  },
  
  // Discover all available devices
  async discoverAll() {
    const allPeers = [];
    
    // BLE peers
    try {
      const blePeers = await this.ble.startScanning();
      allPeers.push(...blePeers.map(p => ({ ...p, layer: 'ble' })));
    } catch (e) {}
    
    // Wi-Fi Direct peers
    try {
      const wifiPeers = await this.wifi.discoverPeers();
      allPeers.push(...wifiPeers.map(p => ({ ...p, layer: 'wifi' })));
    } catch (e) {}
    
    // mDNS peers
    if (this.mdns) {
      const mdnsPeers = this.mdns.getDiscoveredPeers();
      allPeers.push(...mdnsPeers.map(p => ({ ...p, layer: 'mdns' })));
    }
    
    return allPeers;
  },
  
  // Get best available layer
  getBestLayer(peerId) {
    // Priority: BLE > Wi-Fi > mDNS
    if (this.ble.peers.has(peerId)) return 'ble';
    if (this.wifi.peers.has(peerId)) return 'wifi';
    return 'mdns';
  }
};

// Export
window.BLEDiscovery = BLEDiscovery;
window.WiFiDirect = WiFiDirect;
window.DeviceDiscovery = DeviceDiscovery;
console.log('[OurBackyard] BLE + Wi-Fi Direct loaded');
