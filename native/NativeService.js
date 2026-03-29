// NativeService.js - Capacitor Native Features

// ============ Push Notifications (Silent Push) ============
const PushService = {
  initialized: false,
  
  async init() {
    if (this.initialized) return;
    
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications');
      
      // Request permission
      const result = await PushNotifications.requestPermissions();
      if (result.receive !== 'granted') {
        console.log('Push permission denied');
        return;
      }
      
      // Register
      await PushNotifications.register();
      
      // Listen for notifications
      PushNotifications.addEventListener('push', (notification) => {
        console.log('Push received:', notification);
        
        // Handle notification data
        const data = notification.notification.data;
        if (data) {
          if (data.type === 'sos') {
            // SOS notification
            this.handleSOS(data);
          } else if (data.type === 'item') {
            // New item notification
            this.handleNewItem(data);
          }
        }
      });
      
      // Get token
      const token = await PushNotifications.getToken();
      console.log('Push token:', token.token);
      
      // Register with backend
      await this.registerWithBackend(token.token);
      
      this.initialized = true;
    } catch(e) {
      console.log('Push init failed:', e);
    }
  },
  
  async registerWithBackend(token) {
    try {
      await fetch('https://your-api.com/register-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token,
          h3Index: currentH3Index,
          peerId: peerId
        })
      });
    } catch(e) {
      console.log('Register push failed:', e);
    }
  },
  
  handleSOS(data) {
    // Trigger alarm
    triggerHaptic('sos');
    notify(`🚨 SOS from ${data.sender}: ${data.location}`, 'error');
    
    // Show notification
    if (Notification.permission === 'granted') {
      new Notification('🚨 Emergency SOS', {
        body: `${data.sender} needs help at ${data.location}`,
        urgency: 'critical'
      });
    }
  },
  
  handleNewItem(data) {
    notify(`📦 New item: ${data.title}`, 'info');
    // Refresh items
    loadItems();
  }
};

// ============ Network & mDNS Discovery ============
const NetworkService = {
  isOfflineMode: false,
  
  async init() {
    try {
      const { Network } = await import('@capacitor/network');
      
      // Monitor network status
      Network.addListener('networkStatusChange', (status) => {
        console.log('Network status:', status);
        
        if (!status.connected) {
          this.enterOfflineMode();
        } else {
          this.exitOfflineMode();
        }
      });
      
      // Check initial status
      const status = await Network.getStatus();
      if (!status.connected) {
        this.enterOfflineMode();
      }
    } catch(e) {
      console.log('Network init failed:', e);
    }
  },
  
  enterOfflineMode() {
    this.isOfflineMode = true;
    notify('📴 Offline mode - using local network', 'info');
    
    // Try to discover local peers
    this.discoverLocalPeers();
  },
  
  exitOfflineMode() {
    this.isOfflineMode = false;
    notify('🌐 Back online', 'success');
  },
  
  discoverLocalPeers() {
    // Use localStorage as simple peer discovery on same device
    // In production, use mDNS/Bonjour
    console.log('Discovering local peers...');
    
    // Broadcast our presence
    const presence = {
      peerId: peerId,
      displayName: displayName,
      h3Index: currentH3Index,
      timestamp: Date.now()
    };
    
    try {
      localStorage.setItem('ourbackyard_peer', JSON.stringify(presence));
    } catch(e) {}
    
    // Look for other peers
    this.scanForPeers();
  },
  
  scanForPeers() {
    // Check localStorage for other peers
    // This works for same-origin (same network in some cases)
    // Real implementation needs mDNS
    
    setInterval(() => {
      try {
        const data = localStorage.getItem('ourbackyard_peer');
        if (data) {
          const peer = JSON.parse(data);
          if (peer.peerId !== peerId && Date.now() - peer.timestamp < 10000) {
            console.log('Found local peer:', peer);
            // Try P2P connection
          }
        }
      } catch(e) {}
    }, 5000);
  },
  
  async hasInternet() {
    try {
      const { Network } = await import('@capacitor/network');
      const status = await Network.getStatus();
      return status.connected;
    } catch(e) {
      return navigator.onLine;
    }
  }
};

// ============ Initialize on Load ============
// These will only run in Capacitor app, not browser
if (window.Capacitor) {
  PushService.init();
  NetworkService.init();
}

export { PushService, NetworkService };
