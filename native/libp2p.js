// Libp2p P2P Module for OurBackyard
// Pure P2P without centralized signaling server

const Libp2pService = {
  node: null,
  peers: new Map(), // peerId -> { multiaddr, connection }
  messageHandlers: [],
  
  // Initialize libp2p node
  async init() {
    const { createLibp2p } = await import('libp2p');
    const { tcp } = await import('@libp2p/tcp');
    const { mplex } = await import('@libp2p/mplex');
    const { noise } = await import('@libp2p/noise');
    const { bootstrap } = await import('@libp2p/bootstrap');
    const { kadDHT } = await import('@libp2p/kad-dht');
    const { gossipsub } = await import('@libp2p/gossipsub');
    
    // Generate or load peer identity
    const peerId = await this.loadOrGeneratePeerId();
    
    this.node = await createLibp2p({
      peerId,
      addresses: {
        listen: [
          '/ip4/0.0.0.0/tcp/0',  // Random available port
          '/ip4/0.0.0.0/tcp/0/ws'  // WebSocket for browser compatibility
        ]
      },
      transports: [tcp()],
      streamMuxers: [mplex()],
      connectionEncryption: [noise()],
      peerDiscovery: [
        bootstrap({
          list: [
            // Default bootstrap nodes (can be replaced with custom)
            '/ip4/127.0.0.1/tcp/4001/p2p/QmBootstrap1',
            '/ip4/127.0.0.1/tcp/4002/p2p/QmBootstrap2'
          ]
        })
      ],
      services: {
        dht: kadDHT({
          enabled: true,
          protocolPrefix: '/ourbackyard/1.0.0'
        }),
        pubsub: gossipsub({
          enabled: true,
          globalSignaturePolicy: 'StrictNoSign'
        })
      }
    });
    
    console.log('[Libp2p] Node started with peer ID:', this.node.peerId.toString());
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Start the node
    await this.node.start();
    
    return this.node;
  },
  
  // Load or generate peer identity
  async loadOrGeneratePeerId() {
    const { createEd25519PeerId } = await import('@peer-id');
    
    // Try to load from localStorage
    const savedPeerId = localStorage.getItem('libp2p_peerId');
    if (savedPeerId) {
      const { peerIdFromString } = await import('@peer-id');
      return peerIdFromString(savedPeerId);
    }
    
    // Generate new peer ID
    const peerId = await createEd25519PeerId();
    localStorage.setItem('libp2p_peerId', peerId.toString());
    
    return peerId;
  },
  
  // Set up event listeners
  setupEventListeners() {
    // Peer connected
    this.node.addEventListener('peer:connect', (event) => {
      const peerId = event.detail.toString();
      console.log('[Libp2p] Peer connected:', peerId);
      this.peers.set(peerId, { 
        multiaddr: event.detail,
        connected: true 
      });
      this.notifyPeerCount();
    });
    
    // Peer disconnected
    this.node.addEventListener('peer:disconnect', (event) => {
      const peerId = event.detail.toString();
      console.log('[Libp2p] Peer disconnected:', peerId);
      this.peers.delete(peerId);
      this.notifyPeerCount();
    });
    
    // Start DHT discovery
    this.node.services.dht.addEventListener('peer', (event) => {
      console.log('[Libp2p] DHT found peer:', event.detail.id.toString());
    });
  },
  
  // Subscribe to a topic (H3-based)
  async subscribeToTopic(h3Index) {
    const topic = `ourbackyard.h3.${h3Index}`;
    
    await this.node.services.pubsub.subscribe(topic);
    
    this.node.services.pubsub.addEventListener('message', (event) => {
      if (event.detail.topic === topic) {
        const msg = JSON.parse(new TextDecoder().decode(event.detail.message.data));
        this.handleMessage(msg, event.detail.from.toString());
      }
    });
    
    console.log('[Libp2p] Subscribed to:', topic);
  },
  
  // Publish message to topic
  async publish(topic, data) {
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    await this.node.services.pubsub.publish(topic, encoded);
  },
  
  // Publish to H3 topic
  async publishToH3(h3Index, data) {
    const topic = `ourbackyard.h3.${h3Index}`;
    await this.publish(topic, data);
  },
  
  // Handle incoming messages
  handleMessage(msg, fromPeerId) {
    for (const handler of this.messageHandlers) {
      handler(msg, fromPeerId);
    }
  },
  
  // Register message handler
  onMessage(handler) {
    this.messageHandlers.push(handler);
  },
  
  // Connect to specific peer
  async connectToPeer(peerIdStr) {
    try {
      const { peerIdFromString } = await import('@peer-id');
      const peerId = peerIdFromString(peerIdStr);
      await this.node.dial(peerId);
      console.log('[Libp2p] Connected to:', peerIdStr);
      return true;
    } catch (e) {
      console.error('[Libp2p] Failed to connect:', e);
      return false;
    }
  },
  
  // Get peer count
  getPeerCount() {
    return this.peers.size;
  },
  
  // Notify UI of peer count changes
  notifyPeerCount() {
    // This will be called from the main app
    if (window.updatePeerCount) {
      window.updatePeerCount(this.peers.size);
    }
  },
  
  // Stop the node
  async stop() {
    if (this.node) {
      await this.node.stop();
      console.log('[Libp2p] Node stopped');
    }
  },
  
  // Get our peer ID
  getPeerId() {
    return this.node ? this.node.peerId.toString() : null;
  },
  
  // Get peer ID in shorter format
  getShortPeerId() {
    const id = this.getPeerId();
    return id ? id.substring(0, 8) + '...' : null;
  }
};

// Export for use in main app
window.Libp2pService = Libp2pService;
console.log('[OurBackyard] Libp2p Service loaded');
