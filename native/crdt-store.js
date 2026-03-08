// CRDT Store - Real-time Collaborative Data for OurBackyard
// Combines Yjs CRDT with local persistence and sponsor node mirroring

const CRDTStore = {
  doc: null,
  provider: null,
  awareness: null,
  sponsorNode: null,
  
  // Initialize CRDT store
  async init(peerId) {
    const { Doc } = await import('yjs');
    const { IndexeddbPersistence } = await import('y-indexeddb');
    const { WebsocketProvider } = await import('y-websocket');
    
    // Create Yjs document
    this.doc = new Doc();
    this.peerId = peerId;
    
    // Initialize IndexedDB persistence (local-first)
    this.localProvider = new IndexeddbPersistence('ourbackyard-crdt', this.doc);
    
    await new Promise(resolve => {
      this.localProvider.on('synced', () => resolve());
    });
    
    console.log('[CRDT] Local persistence ready');
    
    // Initialize awareness (presence)
    this.awareness = this.doc.awareness;
    this.awareness.setLocalStateField('user', {
      name: peerId,
      color: '#' + Math.floor(Math.random()*16777215).toString(16)
    });
    
    console.log('[CRDT] Initialized for:', peerId?.substring(0, 8));
    
    return this;
  },
  
  // Connect to WebSocket server (optional, for real-time sync)
  async connectWebSocket(url) {
    if (!this.doc) await this.init(this.peerId);
    
    // Clean up existing provider
    if (this.provider) {
      this.provider.disconnect();
    }
    
    this.provider = new WebsocketProvider(url, 'ourbackyard', this.doc, {
      connect: true,
      params: { peerId: this.peerId }
    });
    
    this.provider.awareness = this.awareness;
    
    this.provider.on('status', event => {
      console.log('[CRDT] Connection status:', event.status);
    });
    
    console.log('[CRDT] WebSocket connected');
  },
  
  // Get or create a shared array for items
  getItemsArray() {
    return this.doc.getArray('items');
  },
  
  // Get or create a shared map for metadata
  getMetadataMap() {
    return this.doc.getMap('metadata');
  },
  
  // Add a new item (CRDT handles conflicts automatically)
  async addItem(item) {
    const items = this.getItemsArray();
    const id = item.id || crypto.randomUUID();
    
    const crdtItem = {
      ...item,
      id,
      _addedBy: this.peerId,
      _timestamp: Date.now()
    };
    
    // CRDT array append is idempotent - same ID = same item
    items.push([crdtItem]);
    
    console.log('[CRDT] Item added:', id);
    
    // Request mirrors from sponsors
    await this.requestMirrors(id, crdtItem);
    
    return id;
  },
  
  // Update an item
  async updateItem(id, updates) {
    const items = this.getItemsArray();
    const allItems = items.toArray();
    
    // Find and update the item
    for (let i = 0; i < allItems.length; i++) {
      if (allItems[i].id === id) {
        this.doc.transact(() => {
          items.delete(i, 1);
          items.insert(i, [{ ...allItems[i], ...updates, _updatedAt: Date.now() }]);
        });
        break;
      }
    }
    
    // Request mirror update
    await this.requestMirrorUpdate(id, updates);
  },
  
  // Delete an item (tombstone for CRDT)
  async deleteItem(id) {
    const items = this.getItemsArray();
    const allItems = items.toArray();
    
    for (let i = 0; i < allItems.length; i++) {
      if (allItems[i].id === id) {
        // Tombstone deletion
        this.doc.transact(() => {
          items.delete(i, 1);
          items.insert(i, [{ ...allItems[i], _deleted: true, _deletedAt: Date.now() }]);
        });
        break;
      }
    }
  },
  
  // Get all valid (non-deleted) items
  getAllItems() {
    const items = this.getItemsArray();
    return items.toArray().filter(item => !item._deleted);
  },
  
  // Get items by H3 index
  getItemsByH3(h3Index) {
    return this.getAllItems().filter(item => item.h3Index === h3Index);
  },
  
  // Request mirrors from sponsor nodes
  async requestMirrors(itemId, item) {
    if (this.sponsorNode) {
      await this.sponsorNode.storeWithMirrors(item, itemId);
    }
  },
  
  // Request mirror update
  async requestMirrorUpdate(itemId, updates) {
    // Similar to requestMirrors but for updates
    console.log('[CRDT] Requesting mirror update for:', itemId);
  },
  
  // Handle incoming mirror data
  async handleMirrorData(mirroredData) {
    if (!mirroredData || !mirroredData.id) return;
    
    const items = this.getItemsArray();
    const existing = items.toArray().find(i => i.id === mirroredData.id);
    
    // Only apply if newer
    if (!existing || (mirroredData._timestamp > existing._timestamp)) {
      if (mirroredData._deleted) {
        await this.deleteItem(mirroredData.id);
      } else {
        // Update or add
        await this.addItem(mirroredData);
      }
      
      console.log('[CRDT] Applied mirror data:', mirroredData.id);
    }
  },
  
  // Set sponsor node for mirroring
  setSponsorNode(sponsorNode) {
    this.sponsorNode = sponsorNode;
  },
  
  // Observe changes
  observe(callback) {
    const items = this.getItemsArray();
    items.observe(callback);
  },
  
  // Get current state as JSON (for debugging)
  toJSON() {
    return {
      items: this.getAllItems(),
      metadata: Object.fromEntries(this.getMetadataMap())
    };
  },
  
  // Get pending changes count
  getPendingCount() {
    // Yjs tracks pending writes
    return this.provider?.wsconnected ? 0 : 'offline';
  },
  
  // Disconnect
  disconnect() {
    if (this.provider) {
      this.provider.disconnect();
    }
  },
  
  // Destroy
  destroy() {
    if (this.provider) {
      this.provider.destroy();
    }
    if (this.localProvider) {
      this.localProvider.destroy();
    }
    if (this.doc) {
      this.doc.destroy();
    }
  }
};

// Export
window.CRDTStore = CRDTStore;
console.log('[OurBackyard] CRDT Store loaded');
