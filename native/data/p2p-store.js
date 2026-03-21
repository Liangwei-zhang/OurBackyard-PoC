// Integrated P2P Store - Sponsor Node + CRDT + DHT
// Combines all persistence and discovery into one unified API

const P2PStore = {
  crdt: null,
  sponsor: null,
  discovery: null,
  peerId: null,
  h3Index: null,
  config: {
    mirrorCount: 3,        // Number of sponsor mirrors
    replicationInterval: 60000, // 1 minute
    discoveryInterval: 30000,   // 30 seconds
  },
  
  // Initialize the complete P2P store
  async init(peerId, options = {}) {
    this.peerId = peerId;
    Object.assign(this.config, options);
    
    // Initialize Sponsor Node first (for data persistence)
    await this.initSponsorNode();
    
    // Initialize CRDT (for real-time sync)
    await this.initCRDT();
    
    // Initialize Discovery (DHT + mDNS)
    await this.initDiscovery();
    
    // Connect CRDT to sponsor
    this.crdt.setSponsorNode(this.sponsor);
    
    console.log('[P2PStore] Fully initialized');
    
    return this;
  },
  
  // Initialize Sponsor Node for data mirroring
  async initSponsorNode() {
    // Create IndexedDB for sponsor storage
    const db = new Dexie('SponsorNodeDB');
    db.version(1).stores({
      mirrors: '++id, ownerPeerId, itemId, data, timestamp, synced',
      reputation: 'peerId'
    });
    
    this.sponsor = {
      db,
      peerId: this.peerId,
      
      // Store data with mirrors
      async store(itemId, data) {
        // Store locally
        await db.mirrors.add({
          ownerPeerId: this.peerId,
          itemId,
          data: JSON.stringify(data),
          timestamp: Date.now(),
          synced: false
        });
        
        // Request mirrors from peers
        await this.requestMirrors(itemId, data);
        
        return { stored: true };
      },
      
      // Request mirrors from nearby peers
      async requestMirrors(itemId, data) {
        // Find nearby peers via discovery
        const peers = P2PStore.discovery?.getNearbyPeers(P2PStore.h3Index) || [];
        
        for (const peer of peers.slice(0, P2PStore.config.mirrorCount)) {
          // Send mirror request (would use Libp2p in production)
          console.log('[Sponsor] Requesting mirror from:', peer.peerId?.substring(0, 8));
        }
      },
      
      // Handle incoming mirror request
      async handleMirrorRequest(fromPeerId, itemId, data) {
        await db.mirrors.add({
          ownerPeerId: fromPeerId,
          itemId,
          data: JSON.stringify(data),
          timestamp: Date.now(),
          synced: true,
          mirroredFrom: fromPeerId
        });
        
        // Update reputation
        await this.updateReputation(fromPeerId, 1);
      },
      
      // Update peer reputation
      async updateReputation(peerId, delta) {
        const existing = await db.reputation.get(peerId);
        if (existing) {
          await db.reputation.update(peerId, {
            trustScore: Math.max(0, (existing.trustScore || 0) + delta),
            lastSeen: Date.now()
          });
        } else {
          await db.reputation.add({
            peerId,
            trustScore: 10 + delta,
            lastSeen: Date.now(),
            mirrorsStored: 1
          });
        }
      },
      
      // Get mirrors for a peer (when they're offline)
      async getMirrors(peerId) {
        const mirrors = await db.mirrors
          .where('ownerPeerId')
          .equals(peerId)
          .toArray();
        
        return mirrors.map(m => ({
          itemId: m.itemId,
          data: JSON.parse(m.data),
          timestamp: m.timestamp
        }));
      }
    };
    
    console.log('[P2PStore] Sponsor Node ready');
  },
  
  // Initialize CRDT for real-time sync
  async initCRDT() {
    const { Doc } = await import('yjs');
    const { IndexeddbPersistence } = await import('y-indexeddb');
    
    this.crdt = {
      doc: new Doc(),
      peerId: this.peerId,
      
      // Local persistence
      async sync() {
        const provider = new IndexeddbPersistence('ourbackyard-items', this.doc);
        await new Promise(r => provider.on('synced', r));
        return provider;
      },
      
      // Get items array
      getItems() {
        return this.doc.getArray('items').toArray();
      },
      
      // Add item
      addItem(item) {
        const id = item.id || crypto.randomUUID();
        const crdtItem = { ...item, id, _addedBy: this.peerId, _timestamp: Date.now() };
        this.doc.getArray('items').push([crdtItem]);
        return id;
      },
      
      // Update item
      updateItem(id, updates) {
        const items = this.doc.getArray('items');
        const arr = items.toArray();
        
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].id === id) {
            items.delete(i, 1);
            items.insert(i, [{ ...arr[i], ...updates, _updatedAt: Date.now() }]);
            break;
          }
        }
      },
      
      // Delete item (tombstone)
      deleteItem(id) {
        const items = this.doc.getArray('items');
        const arr = items.toArray();
        
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].id === id) {
            items.delete(i, 1);
            items.insert(i, [{ ...arr[i], _deleted: true, _deletedAt: Date.now() }]);
            break;
          }
        }
      },
      
      // Get valid items
      getValidItems() {
        return this.getItems().filter(i => !i._deleted);
      },
      
      // Observe changes
      observe(callback) {
        this.doc.getArray('items').observe(callback);
      }
    };
    
    await this.crdt.sync();
    console.log('[P2PStore] CRDT ready');
  },
  
  // Initialize Discovery
  async initDiscovery() {
    // Set H3 index for geographic routing
    this.h3Index = window.currentH3Index || 'unknown';
    
    this.discovery = {
      h3Index: this.h3Index,
      peers: new Map(),
      
      // Start discovery loop
      start() {
        this.interval = setInterval(() => this.discover(), P2PStore.config.discoveryInterval);
        this.discover(); // Initial discovery
      },
      
      // Stop discovery
      stop() {
        if (this.interval) clearInterval(this.interval);
      },
      
      // Discover nearby peers
      discover() {
        // Use mDNS for local discovery
        const found = this.scanMDNS();
        
        found.forEach(peer => {
          this.peers.set(peer.peerId, {
            ...peer,
            lastSeen: Date.now()
          });
        });
        
        // Clean stale peers
        const now = Date.now();
        for (const [id, peer] of this.peers) {
          if (now - peer.lastSeen > 60000) {
            this.peers.delete(id);
          }
        }
        
        console.log('[Discovery] Found', this.peers.size, 'peers');
      },
      
      // Scan mDNS
      scanMDNS() {
        const found = [];
        const now = Date.now();
        
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('mDNS_')) {
              try {
                const data = JSON.parse(localStorage.getItem(key));
                if (data.peerId !== P2PStore.peerId && now - data.timestamp < 10000) {
                  found.push(data);
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
        
        return found;
      },
      
      // Get nearby peers
      getNearbyPeers(h3Index) {
        return Array.from(this.peers.values())
          .filter(p => p.h3Index === h3Index);
      },
      
      // Get all peers
      getAllPeers() {
        return Array.from(this.peers.values());
      }
    };
    
    this.discovery.start();
    console.log('[P2PStore] Discovery ready');
  },
  
  // ============ Public API ============
  
  // Add item (main entry point)
  async addItem(item) {
    const id = this.crdt.addItem(item);
    
    // Request mirrors from sponsors
    await this.sponsor.store(id, { ...item, id });
    
    return id;
  },
  
  // Update item
  async updateItem(id, updates) {
    this.crdt.updateItem(id, updates);
    await this.sponsor.store(id, { id, ...updates });
  },
  
  // Delete item
  async deleteItem(id) {
    this.crdt.deleteItem(id);
  },
  
  // Get all items
  getItems() {
    return this.crdt.getValidItems();
  },
  
  // Get items by H3
  getItemsByH3(h3Index) {
    return this.crdt.getValidItems().filter(i => i.h3Index === h3Index);
  },
  
  // Get peer count
  getPeerCount() {
    return this.discovery?.peers.size || 0;
  },
  
  // Observe changes
  observe(callback) {
    this.crdt.observe(callback);
  },
  
  // Sync (for offline recovery)
  async sync() {
    // Get mirrors from sponsors
    const peers = this.discovery.getAllPeers();
    
    for (const peer of peers) {
      const mirrors = await this.sponsor.getMirrors(peer.peerId);
      
      for (const mirror of mirrors) {
        // Apply mirror if newer
        const existing = this.crdt.getItems().find(i => i.id === mirror.itemId);
        if (!existing || mirror.timestamp > (existing._timestamp || 0)) {
          if (mirror.data._deleted) {
            this.crdt.deleteItem(mirror.itemId);
          } else {
            this.crdt.addItem(mirror.data);
          }
        }
      }
    }
    
    console.log('[P2PStore] Sync complete');
  },
  
  // Shutdown
  destroy() {
    if (this.discovery) this.discovery.stop();
    if (this.crdt?.doc) this.crdt.doc.destroy();
  }
};

// Export
window.P2PStore = P2PStore;
console.log('[OurBackyard] P2P Store loaded');
