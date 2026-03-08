# mDNS Local Discovery System

## Concept: Zero-Config Local Network P2P

When internet is down, use mDNS/Bonjour to discover neighbors on local network.

## Capacitor Plugin Setup

```bash
npm install @capacitor/network
npm install capacitor-native-network-discovery
npx cap sync
```

## Implementation

### NetworkDiscovery Service
```javascript
// network-service.js
import { Network } from '@capacitor/network';

const NetworkDiscovery = {
  localIP: null,
  peerMap: new Map(), // ip -> peerInfo
  
  async init() {
    // Get local network info
    const status = await Network.getStatus();
    console.log('Network status:', status);
    
    // Start mDNS discovery
    this.startMDNS();
  },
  
  async startMDNS() {
    // Use bonjour-native or similar for mDNS discovery
    // This is the concept - requires native plugin
    
    // Broadcast our presence
    this.broadcastPresence();
    
    // Listen for other devices
    setInterval(() => {
      this.broadcastPresence();
    }, 5000); // Every 5 seconds
  },
  
  broadcastPresence() {
    // In a real implementation, this would use mDNS
    // For now, we'll use localStorage as a simple broadcast mechanism
    // when on the same network
    
    const presence = {
      peerId: peerId,
      displayName: displayName,
      h3Index: currentH3Index,
      timestamp: Date.now(),
      localIP: this.localIP
    };
    
    // Store in localStorage for same-origin sharing
    localStorage.setItem('ourbackyard_presence_' + peerId, JSON.stringify(presence));
  },
  
  async discoverLocalPeers() {
    // Check for other peers' presence
    const peers = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('ourbackyard_presence_')) {
        try {
          const data = JSON.parse(localStorage.getItem(key));
          // Only include recent presence (within 10 seconds)
          if (Date.now() - data.timestamp < 10000) {
            peers.push(data);
          }
        } catch(e) {}
      }
    }
    return peers;
  },
  
  // Fallback: Try direct IP connection
  async tryDirectConnection(peerIP) {
    // Attempt WebRTC connection via local IP
    // This bypasses the need for TURN when on same network
    
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: `stun:${peerIP}:3478` } // Local STUN
      ]
    });
    
    // Create data channel
    const dc = pc.createDataChannel('local', { ordered: true });
    
    // ... rest of WebRTC setup
  },
  
  // Check if we can reach external internet
  async hasInternet() {
    try {
      const response = await fetch('https://www.google.com', { 
        method: 'HEAD',
        mode: 'no-cors'
      });
      return true;
    } catch(e) {
      return false;
    }
  },
  
  // Emergency mode: offline P2P
  async enterEmergencyMode() {
    console.log('Entering emergency offline mode');
    
    // Discover local peers
    const localPeers = await this.discoverLocalPeers();
    console.log('Found local peers:', localPeers.length);
    
    // Try to connect to each
    for (const peer of localPeers) {
      if (peer.peerId !== peerId) {
        console.log('Attempting local connection to', peer.displayName);
        // tryDirectConnection(peer.localIP);
      }
    }
  }
};

export default NetworkDiscovery;
```

## Emergency Mode Activation

```javascript
// In your app - check for network and switch mode
async function checkConnectivity() {
  const hasNet = await NetworkDiscovery.hasInternet();
  
  if (!hasNet) {
    notify('📴 No internet - entering local mode', 'info');
    await NetworkDiscovery.enterEmergencyMode();
  }
}

// Run connectivity check periodically
setInterval(checkConnectivity, 30000); // Every 30 seconds
```

## Network Modes

| Mode | Internet | Discovery | Connection |
|------|----------|-----------|------------|
| Normal | ✅ | WebSocket Server | TURN/STUN |
| Local | ❌ | mDNS/Bonjour | Direct LAN IP |
| Emergency | ❌ | localStorage | Direct P2P |

## Android mDNS Configuration

In `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE"/>
<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE"/>
```

## iOS mDNS Configuration

In `ios/App/Info.plist`:
```xml
<key>NSLocalNetworkUsageDescription</key>
<string>OurBackyard needs to discover nearby neighbors on your local network.</string>
<key>NSBonjourServices</key>
<array>
    <string>_ourbackyard._tcp</string>
</array>
```

## How It Works

```
┌─────────────────────────────────────┐
│         Internet Available?          │
└──────────────┬──────────────────────┘
               │
        ┌──────┴──────┐
        │             │
       ✅            ❌
        │             │
        ▼             ▼
┌───────────┐  ┌─────────────┐
│ Normal    │  │ Emergency   │
│ Mode      │  │ Mode        │
├───────────┤  ├─────────────┤
│ WS Server │  │ mDNS        │
│ TURN      │  │ Discovery   │
│ Cloudflare│  │ Local IP   │
└───────────┘  └─────────────┘
```

When the internet goes down:
1. App detects no connectivity
2. Switches to Emergency Mode
3. Uses mDNS to discover local neighbors
4. Establishes direct P2P connection via LAN
5. Continues to share items and SOS alerts locally
