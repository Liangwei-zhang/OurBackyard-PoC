// Local AI - Semantic Search for OurBackyard
// Uses local embeddings for privacy-preserving smart matching

const LocalAI = {
  db: null,
  embeddings: new Map(), // itemId -> embedding vector
  modelLoaded: false,
  
  // Initialize local AI
  async init() {
    // Open IndexedDB for embeddings storage
    this.db = new Dexie('LocalAIDB');
    this.db.version(1).stores({
      embeddings: 'itemId, vector',
      cache: 'key, value'
    });
    
    console.log('[LocalAI] Initialized');
    
    // Try to load model (placeholder for WebLLM/Transformers.js)
    await this.loadModel();
    
    return this;
  },
  
  // Load local embedding model
  async loadModel() {
    // In production, use:
    // - Transformers.js for BERT embeddings
    // - WebLLM for LLM inference
    
    try {
      // Check if we can use Transformers.js
      // const pipeline = await import('@xenova/transformers');
      // this.pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      
      this.modelLoaded = true;
      console.log('[LocalAI] Model ready (simulated)');
      
    } catch (e) {
      console.log('[LocalAI] Using simple embedding fallback');
      this.modelLoaded = true;
    }
  },
  
  // Generate embedding for text (simple hash-based for now)
  async generateEmbedding(text) {
    if (!this.modelLoaded) {
      throw new Error('Model not loaded');
    }
    
    // Simple embedding using character frequencies
    // In production, use proper transformer embeddings
    const embedding = new Array(384).fill(0);
    
    // Normalize text
    const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, ' ');
    const words = normalized.split(/\s+/);
    
    // Create simple hash-based embedding
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      let hash = 0;
      for (let j = 0; j < word.length; j++) {
        hash = ((hash << 5) - hash) + word.charCodeAt(j);
        hash = hash & hash;
      }
      
      // Distribute across embedding vector
      const idx1 = Math.abs(hash) % embedding.length;
      const idx2 = (Math.abs(hash) >> 8) % embedding.length;
      
      embedding[idx1] += 1;
      embedding[idx2] += 0.5;
    }
    
    // Normalize to unit vector
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }
    
    return embedding;
  },
  
  // Index an item for search
  async indexItem(item) {
    // Combine searchable text
    const text = [
      item.title,
      item.description,
      item.category,
      item.condition
    ].filter(Boolean).join(' ');
    
    // Generate embedding
    const embedding = await this.generateEmbedding(text);
    
    // Store in database
    await this.db.embeddings.put({
      itemId: item.id,
      text: text,
      vector: embedding,
      timestamp: Date.now()
    });
    
    // Also store in memory for fast access
    this.embeddings.set(item.id, embedding);
    
    console.log('[LocalAI] Indexed item:', item.id);
  },
  
  // Semantic search
  async search(query, limit = 10) {
    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);
    
    // Get all indexed items
    const items = await this.db.embeddings.toArray();
    
    // Calculate cosine similarity
    const results = items.map(item => {
      const similarity = this.cosineSimilarity(queryEmbedding, item.vector);
      return {
        itemId: item.itemId,
        text: item.text,
        similarity
      };
    });
    
    // Sort by similarity and return top results
    results.sort((a, b) => b.similarity - a.similarity);
    
    return results.slice(0, limit).filter(r => r.similarity > 0.1);
  },
  
  // Cosine similarity between two vectors
  cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator > 0 ? dotProduct / denominator : 0;
  },
  
  // Smart matching - find relevant items based on context
  async smartMatch(context) {
    // Context can include:
    // - User's recent searches
    // - User's posted items
    // - Time of day
    // - Location
    
    const queries = [];
    
    // Extract potential queries from context
    if (context.recentSearches) {
      queries.push(...context.recentSearches);
    }
    
    // Add time-based suggestions
    const hour = new Date().getHours();
    if (hour >= 8 && hour <= 10) {
      queries.push('breakfast coffee swap');
    } else if (hour >= 17 && hour <= 19) {
      queries.push('dinner ingredients exchange');
    }
    
    // Search for each query and combine results
    const allResults = new Map();
    
    for (const query of queries) {
      const results = await this.search(query, 5);
      for (const r of results) {
        const existing = allResults.get(r.itemId);
        if (!existing || existing.similarity < r.similarity) {
          allResults.set(r.itemId, r);
        }
      }
    }
    
    return Array.from(allResults.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10);
  },
  
  // Delete item from index
  async deleteItem(itemId) {
    await this.db.embeddings.delete(itemId);
    this.embeddings.delete(itemId);
  },
  
  // Re-index all items
  async reindexAll(items) {
    await this.db.embeddings.clear();
    this.embeddings.clear();
    
    for (const item of items) {
      await this.indexItem(item);
    }
    
    console.log('[LocalAI] Reindexed', items.length, 'items');
  },
  
  // Get index stats
  async getStats() {
    const count = await this.db.embeddings.count();
    return {
      indexedItems: count,
      modelLoaded: this.modelLoaded,
      modelType: 'simple-embedding' // Would be 'bert' in production
    };
  }
};

// Export
window.LocalAI = LocalAI;
console.log('[OurBackyard] Local AI loaded');
