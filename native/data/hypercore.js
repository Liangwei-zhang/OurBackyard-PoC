// Hypercore-inspired Storage for OurBackyard
// Append-only log with Merkle tree verification

const HypercoreStore = {
  core: null,
  storage: null,
  
  // Initialize storage
  async init(peerId) {
    this.peerId = peerId;
    
    // Use IndexedDB for block storage
    this.db = new Dexie('OurBackyardHypercore');
    this.db.version(1).stores({
      blocks: 'key, hash',
      merkle: 'hash',
      metadata: 'key'
    });
    
    console.log('[Hypercore] Storage initialized for:', peerId?.substring(0, 8) || 'anonymous');
    
    return this;
  },
  
  // Append data to the log
  async append(data) {
    const timestamp = Date.now();
    const entry = {
      key: this.peerId,
      timestamp,
      data,
      sequence: await this.getLength()
    };
    
    // Calculate hash for this entry
    entry.hash = await this.hashEntry(entry);
    
    // Store the block
    await this.db.blocks.add({
      key: entry.hash,
      value: entry,
      timestamp
    });
    
    // Update Merkle tree
    await this.updateMerkle(entry);
    
    console.log('[Hypercore] Appended entry:', entry.hash?.substring(0, 8));
    
    return entry;
  },
  
  // Get entry by hash
  async get(hash) {
    return await this.db.blocks.get(hash);
  },
  
  // Get all entries (for syncing)
  async getAll() {
    return await this.db.blocks.toArray();
  },
  
  // Get length of log
  async getLength() {
    return await this.db.blocks.count();
  },
  
  // Get root hash
  async getRootHash() {
    const meta = await this.db.metadata.get('rootHash');
    return meta?.value || null;
  },
  
  // Calculate hash for entry (simple hash for performance)
  async hashEntry(entry) {
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(entry));
    
    // Use SubtleCrypto for hashing
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return this.bufferToHex(hashBuffer);
  },
  
  // Update Merkle tree
  async updateMerkle(entry) {
    const entries = await this.getAll();
    const hashes = entries.map(e => e.key);
    
    // Build Merkle tree
    const tree = this.buildMerkleTree(hashes);
    const root = tree[tree.length - 1][0];
    
    // Store root hash
    await this.db.metadata.put({ key: 'rootHash', value: root });
    
    return root;
  },
  
  // Build Merkle tree from hashes
  buildMerkleTree(hashes) {
    if (hashes.length === 0) return [[this.zeroHash()]];
    
    let level = hashes;
    const tree = [level];
    
    while (level.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) {
          // Combine two hashes
          const combined = level[i] + level[i + 1];
          const hash = this.simpleHash(combined);
          nextLevel.push(hash);
        } else {
          // Odd one out - just carry forward
          nextLevel.push(level[i]);
        }
      }
      tree.push(nextLevel);
      level = nextLevel;
    }
    
    return tree;
  },
  
  // Simple hash function (faster than SHA-256 for mobile)
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16).padStart(8, '0');
  },
  
  // Zero hash for empty trees
  zeroHash() {
    return '0'.repeat(64);
  },
  
  // Buffer to hex
  bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },
  
  // Create sync proof
  async createSyncProof() {
    const root = await this.getRootHash();
    const length = await this.getLength();
    
    return {
      root,
      length,
      peerId: this.peerId
    };
  },
  
  // Verify sync proof
  async verifySyncProof(proof) {
    const localRoot = await this.getRootHash();
    return localRoot === proof.root;
  },
  
  // Find missing entries (for incremental sync)
  async findMissing(remoteHashes) {
    const local = await this.getAll();
    const localHashes = new Set(local.map(e => e.key));
    
    const missing = [];
    for (const hash of remoteHashes) {
      if (!localHashes.has(hash)) {
        missing.push(hash);
      }
    }
    
    return missing;
  },
  
  // Get entries by hash (for sync)
  async getEntriesByHash(hashes) {
    const entries = [];
    for (const hash of hashes) {
      const entry = await this.get(hash);
      if (entry) entries.push(entry.value);
    }
    return entries;
  },
  
  // Clear all data
  async clear() {
    await this.db.blocks.clear();
    await this.db.merkle.clear();
    await this.db.metadata.clear();
    console.log('[Hypercore] Storage cleared');
  }
};

// Export for use in main app
window.HypercoreStore = HypercoreStore;
console.log('[OurBackyard] Hypercore Store loaded');
