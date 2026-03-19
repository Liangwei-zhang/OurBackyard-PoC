// Dead Drop Buffering
// Async message delivery through relay nodes

const DeadDrop = {
  config: {
    maxDropSize: 100,      // Max messages per drop
    ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
    redundancy: 3           // Number of relay nodes
  },
  
  db: null,
  
  // Initialize
  async init() {
    this.db = new Dexie('DeadDropDB');
    this.db.version(1).stores({
      drops: 'id, recipient, timestamp, expiresAt',
      messages: 'id, dropId, chunkIndex, data'
    });
    
    console.log('[DeadDrop] Initialized');
    return this;
  },
  
  // Create dead drop for recipient
  async createDrop(recipientDid, messages) {
    const dropId = crypto.randomUUID();
    const now = Date.now();
    
    // Create drop record
    await this.db.drops.add({
      id: dropId,
      recipient: recipientDid,
      sender: this.myDid,
      messageCount: messages.length,
      timestamp: now,
      expiresAt: now + this.config.ttl
    });
    
    // Store messages with erasure coding
    const fullData = JSON.stringify(messages);
    const chunks = this.chunkString(fullData, 1000);
    
    for (let i = 0; i < chunks.length; i++) {
      await this.db.messages.add({
        id: crypto.randomUUID(),
        dropId,
        chunkIndex: i,
        data: chunks[i]
      });
    }
    
    console.log('[DeadDrop] Created drop for', recipientDid?.substring(0, 8), 'with', chunks.length, 'chunks');
    
    return { dropId, chunkCount: chunks.length };
  },
  
  // Chunk string for storage
  chunkString(str, size) {
    const chunks = [];
    for (let i = 0; i < str.length; i += size) {
      chunks.push(str.slice(i, i + size));
    }
    return chunks;
  },
  
  // Retrieve dead drop
  async retrieveDrop(dropId) {
    const drop = await this.db.drops.get(dropId);
    if (!drop) return null;
    
    // Check expiry
    if (Date.now() > drop.expiresAt) {
      await this.deleteDrop(dropId);
      return null;
    }
    
    // Get all chunks
    const chunks = await this.db.messages
      .where('dropId')
      .equals(dropId)
      .sortBy('chunkIndex');
    
    if (chunks.length === 0) return null;
    
    // Reassemble
    const data = chunks.map(c => c.data).join('');
    const messages = JSON.parse(data);
    
    return { drop, messages };
  },
  
  // Find drops for recipient
  async findMyDrops(myDid) {
    const drops = await this.db.drops
      .where('recipient')
      .equals(myDid)
      .toArray();
    
    // Filter expired
    const valid = drops.filter(d => Date.now() < d.expiresAt);
    
    return valid;
  },
  
  // Delete drop
  async deleteDrop(dropId) {
    await this.db.drops.delete(dropId);
    await this.db.messages.where('dropId').equals(dropId).delete();
  },
  
  // Cleanup expired drops
  async cleanup() {
    const now = Date.now();
    const expired = await this.db.drops
      .where('expiresAt')
      .below(now)
      .toArray();
    
    for (const drop of expired) {
      await this.deleteDrop(drop.id);
    }
    
    console.log('[DeadDrop] Cleaned up', expired.length, 'expired drops');
  },
  
  // Announce as dead drop relay
  async announceRelay(capabilities = {}) {
    const announcement = {
      type: 'DEADDROP_RELAY',
      peerId: this.myDid,
      capacity: capabilities.capacity || 100,
      currentLoad: await this.getLoad(),
      timestamp: Date.now()
    };
    
    try {
      localStorage.setItem('deaddrop_' + this.myDid, JSON.stringify(announcement));
    } catch (e) {}
    
    console.log('[DeadDrop] Announced as relay');
  },
  
  // Get current load
  async getLoad() {
    return await this.db.drops.count();
  },
  
  // Find relay nodes
  async findRelays(count = 3) {
    const relays = [];
    
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('deaddrop_')) {
          const relay = JSON.parse(localStorage.getItem(key));
          if (relay.capacity > relay.currentLoad) {
            relays.push(relay);
          }
        }
      }
    } catch (e) {}
    
    return relays.slice(0, count);
  }
};

window.DeadDrop = DeadDrop;
console.log('[OurBackyard] Dead Drop loaded');
