// Log Compaction & Snapshots for Hypercore
// Compresses append-only logs to save storage

const LogCompaction = {
  config: {
    maxLogSize: 10000,    // Max entries before compaction
    snapshotInterval: 5000, // Create snapshot every N entries
    pruneAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  },
  
  db: null,
  
  // Initialize
  async init() {
    this.db = new Dexie('LogCompactionDB');
    this.db.version(1).stores({
      logs: '++id, timestamp, compacted',
      snapshots: 'id, rootHash, entryCount, timestamp'
    });
    
    console.log('[Compaction] Initialized');
    return this;
  },
  
  // Add log entry
  async addEntry(data) {
    const entry = {
      data,
      timestamp: Date.now(),
      hash: await this.computeHash(data),
      compacted: false
    };
    
    const id = await this.db.logs.add(entry);
    
    // Check if compaction needed
    const count = await this.db.logs.count();
    if (count >= this.config.maxLogSize) {
      await this.compact();
    }
    
    return id;
  },
  
  // Compact logs into snapshot
  async compact() {
    console.log('[Compaction] Starting compaction...');
    
    // Get all uncompacted entries
    const entries = await this.db.logs
      .where('compacted')
      .equals(false)
      .toArray();
    
    if (entries.length < 100) {
      console.log('[Compaction] Not enough entries to compact');
      return null;
    }
    
    // Compute merkle root
    const rootHash = await this.computeMerkleRoot(entries);
    
    // Create snapshot
    const snapshot = {
      id: crypto.randomUUID(),
      rootHash,
      entryCount: entries.length,
      firstTimestamp: entries[0]?.timestamp,
      lastTimestamp: entries[entries.length - 1]?.timestamp,
      timestamp: Date.now()
    };
    
    await this.db.snapshots.add(snapshot);
    
    // Mark entries as compacted
    const ids = entries.map(e => e.id);
    await this.db.logs.where('id').anyOf(ids).modify({ compacted: true });
    
    // Delete old compacted entries
    const oldThreshold = Date.now() - this.config.pruneAge;
    await this.db.logs
      .where('timestamp')
      .below(oldThreshold)
      .delete();
    
    console.log('[Compaction] Compacted', entries.length, 'entries into snapshot');
    
    return snapshot;
  },
  
  // Create snapshot manually
  async createSnapshot() {
    return await this.compact();
  },
  
  // Verify snapshot
  async verifySnapshot(snapshotId) {
    const snapshot = await this.db.snapshots.get(snapshotId);
    if (!snapshot) return { valid: false, reason: 'not_found' };
    
    // Get compacted entries
    const entries = await this.db.logs
      .where('timestamp')
      .between(snapshot.firstTimestamp, snapshot.lastTimestamp, true, true)
      .toArray();
    
    // Verify root hash
    const rootHash = await this.computeMerkleRoot(entries);
    
    return {
      valid: rootHash === snapshot.rootHash,
      entryCount: entries.length,
      snapshot
    };
  },
  
  // Get state at timestamp
  async getStateAt(timestamp) {
    const entries = await this.db.logs
      .where('timestamp')
      .below(timestamp)
      .toArray();
    
    return entries.map(e => e.data);
  },
  
  // Get latest snapshot
  async getLatestSnapshot() {
    return await this.db.snapshots
      .orderBy('timestamp')
      .last();
  },
  
  // Get stats
  async getStats() {
    const logCount = await this.db.logs.count();
    const snapshotCount = await this.db.snapshots.count();
    const latestSnapshot = await this.getLatestSnapshot();
    
    return {
      logEntries: logCount,
      snapshots: snapshotCount,
      latestSnapshot,
      storageEstimate: logCount * 500 // ~500 bytes per entry
    };
  },
  
  // Compute hash
  async computeHash(data) {
    const encoder = new TextEncoder();
    const buffer = encoder.encode(JSON.stringify(data));
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },
  
  // Compute merkle root
  async computeMerkleRoot(entries) {
    if (entries.length === 0) return '0'.repeat(64);
    
    let hashes = entries.map(e => e.hash);
    
    while (hashes.length > 1) {
      const next = [];
      for (let i = 0; i < hashes.length; i += 2) {
        if (i + 1 < hashes.length) {
          const combined = hashes[i] + hashes[i + 1];
          const hash = await this.computeHash(combined);
          next.push(hash);
        } else {
          next.push(hashes[i]);
        }
      }
      hashes = next;
    }
    
    return hashes[0];
  }
};

// Export
window.LogCompaction = LogCompaction;
console.log('[OurBackyard] Log Compaction loaded');
