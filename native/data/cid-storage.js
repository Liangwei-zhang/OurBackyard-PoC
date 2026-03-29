/**
 * CID Content Addressable Storage - 完全去中心化存儲
 * 
 * 技術實現：
 * - SHA-256 內容哈希作為 CID
 * - 多級緩存：內存 → OPFS → DHT 網絡
 * - 圖片去重（相同內容 = 相同 CID）
 * - 永久鏈接（只要社區有人存過，圖片永不消失）
 * 
 * 使用方式：
 * const cidStorage = new CIDStorage();
 * await cidStorage.init();
 * const cid = await cidStorage.store(blob);
 * const blob = await cidStorage.retrieve(cid);
 */

class CIDStorage {
  constructor() {
    // 內存緩存
    this.cache = new Map(); // cid -> { blob, timestamp, refs }
    
    // OPFS 引用計數
    this.refs = new Map(); // cid -> count
    
    // 配置
    this.config = {
      maxMemoryCache: 50 * 1024 * 1024, // 50MB 內存緩存
      maxMemoryItems: 100, // 最多 100 個項目
      cacheTTL: 7 * 24 * 60 * 60 * 1000, // 7 天 TTL
      chunkSize: 16384 // 分片大小
    };
    
    // 當前內存使用
    this.memoryUsage = 0;
    
    // 初始化標誌
    this.initialized = false;
  }
  
  /**
   * 初始化存儲系統
   */
  async init() {
    console.log('[CID] Initializing content-addressable storage...');
    
    // 加載 OPFS 引用計數
    await this.loadRefs();
    
    // 清理過期緩存
    await this.cleanExpired();
    
    this.initialized = true;
    console.log('[CID] Storage initialized,', this.refs.size, 'items in network');
    
    return this;
  }
  
  /**
   * 計算內容的 CID (SHA-256)
   */
  async computeCID(blob) {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    // multiformat 風格編碼
    // version 1 (00) + content type (55 = dag-pb) + hash (SHA2-256 = 12)
    // 使用 base36 壓縮
    return 'cid1-' + this.base36Encode(hashHex);
  }
  
  /**
   * Base36 編碼
   */
  base36Encode(hex) {
    try {
      const num = BigInt('0x' + hex);
      return num.toString(36);
    } catch (e) {
      // 如果失敗，使用原始 hex
      return hex.substring(0, 32);
    }
  }
  
  /**
   * 存儲內容
   */
  async store(blob, metadata = {}) {
    const cid = await this.computeCID(blob);
    
    // 檢查是否已存在（去重）
    if (this.cache.has(cid)) {
      console.log('[CID] Content already cached:', cid);
      this.refs.set(cid, (this.refs.get(cid) || 0) + 1);
      await this.saveRefs();
      return cid;
    }
    
    // 檢查 OPFS
    const opfsBlob = await this.loadFromOPFS(cid);
    if (opfsBlob) {
      console.log('[CID] Content found in OPFS:', cid);
      this.cache.set(cid, {
        blob: opfsBlob,
        timestamp: Date.now(),
        size: opfsBlob.size,
        refs: 1
      });
      this.refs.set(cid, (this.refs.get(cid) || 0) + 1);
      await this.saveRefs();
      return cid;
    }
    
    // 計算大小
    const size = blob.size;
    
    // 內存緩存（LRU 驅逐）
    await this.evictIfNeeded(size);
    
    // 存儲到內存
    this.cache.set(cid, {
      blob,
      timestamp: Date.now(),
      size,
      refs: 1,
      metadata
    });
    this.memoryUsage += size;
    
    // 持久化到 OPFS
    await this.saveToOPFS(cid, blob);
    
    // 更新引用計數
    this.refs.set(cid, 1);
    await this.saveRefs();
    
    console.log('[CID] Stored:', cid, 'size:', size);
    
    // 廣播到網絡（可選）
    this.provide(cid);
    
    return cid;
  }
  
  /**
   * 檢索內容
   */
  async retrieve(cid) {
    // 1. 內存緩存
    const cached = this.cache.get(cid);
    if (cached) {
      console.log('[CID] Retrieved from memory:', cid);
      return cached.blob;
    }
    
    // 2. OPFS
    const opfsBlob = await this.loadFromOPFS(cid);
    if (opfsBlob) {
      console.log('[CID] Retrieved from OPFS:', cid);
      // 還原到內存
      await this.store(opfsBlob);
      return opfsBlob;
    }
    
    // 3. 網絡請求
    console.log('[CID] Requesting from network:', cid);
    const blob = await this.requestFromNetwork(cid);
    if (blob) {
      await this.store(blob);
      return blob;
    }
    
    console.warn('[CID] Content not found:', cid);
    return null;
  }
  
  /**
   * 獲取內容（不解碼）
   */
  async has(cid) {
    return this.cache.has(cid) || await this.existsInOPFS(cid);
  }
  
  /**
   * 請求網絡（廣播 CID 請求）
   */
  async requestFromNetwork(cid) {
    return new Promise((resolve) => {
      // 設置超時
      const timeout = setTimeout(() => {
        resolve(null);
      }, 15000);
      
      // 通過 P2P 廣播請求
      if (this.onRequest) {
        this.onRequest(cid);
      }
      
      // 通過 WebSocket 請求（作為備用）
      if (typeof ws !== 'undefined' && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'CID_REQUEST',
          cid: cid,
          from: peerId
        }));
      }
      
      // 等待響應（在 handleCIDResponse 中處理）
      this.pendingRequests = this.pendingRequests || new Map();
      this.pendingRequests.set(cid, { timeout, resolve });
    });
  }
  
  /**
   * 處理網絡響應
   */
  async handleResponse(cid, blob) {
    const request = this.pendingRequests?.get(cid);
    if (request) {
      clearTimeout(request.timeout);
      request.resolve(blob);
      this.pendingRequests.delete(cid);
    }
  }
  
  /**
   * 提供內容（廣告我有這個 CID）
   */
  provide(cid) {
    if (typeof ws !== 'undefined' && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'CID_PROVIDE',
        cid: cid,
        from: peerId
      }));
    }
  }
  
  /**
   * 處理對方的提供
   */
  handleProvide(cid, peerId) {
    console.log('[CID] Peer', peerId, 'has:', cid);
    // 可以記住誰有這個內容，以便請求
    this.providers = this.providers || new Map();
    this.providers.set(cid, peerId);
  }
  
  /**
   * 保存到 OPFS
   */
  async saveToOPFS(cid, blob) {
    try {
      if (!('storage' in navigator && 'getDirectory' in navigator.storage)) {
        return false;
      }
      
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle('cid_' + cid, { create: true });
      const writable = await handle.createWritable();
      await writable.write(await blob.arrayBuffer());
      await writable.close();
      
      return true;
    } catch (e) {
      console.error('[CID] OPFS save error:', e);
      return false;
    }
  }
  
  /**
   * 從 OPFS 加載
   */
  async loadFromOPFS(cid) {
    try {
      if (!('storage' in navigator && 'getDirectory' in navigator.storage)) {
        return null;
      }
      
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle('cid_' + cid);
      const file = await handle.getFile();
      
      return new Blob([await file.arrayBuffer()], { type: 'image/jpeg' });
    } catch (e) {
      return null;
    }
  }
  
  /**
   * 檢查 OPFS 是否存在
   */
  async existsInOPFS(cid) {
    try {
      if (!('storage' in navigator && 'getDirectory' in navigator.storage)) {
        return false;
      }
      
      const dir = await navigator.storage.getDirectory();
      await dir.getFileHandle('cid_' + cid);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  /**
   * LRU 驅逐
   */
  async evictIfNeeded(requiredSize) {
    // 檢查數量限制
    if (this.cache.size >= this.config.maxMemoryItems) {
      // 移除最早的
      let oldest = null;
      let oldestTime = Date.now();
      
      for (const [cid, data] of this.cache) {
        if (data.refs <= 1) { // 只驅逐引用為 1 的
          if (data.timestamp < oldestTime) {
            oldestTime = data.timestamp;
            oldest = cid;
          }
        }
      }
      
      if (oldest) {
        const removed = this.cache.get(oldest);
        this.cache.delete(oldest);
        this.memoryUsage -= removed.size;
        console.log('[CID] Evicted:', oldest);
      }
    }
    
    // 檢查大小限制
    while (this.memoryUsage + requiredSize > this.config.maxMemoryCache && this.cache.size > 0) {
      // 移除最早的
      let oldest = null;
      let oldestTime = Date.now();
      
      for (const [cid, data] of this.cache) {
        if (data.refs <= 1) {
          if (data.timestamp < oldestTime) {
            oldestTime = data.timestamp;
            oldest = cid;
          }
        }
      }
      
      if (oldest) {
        const removed = this.cache.get(oldest);
        this.cache.delete(oldest);
        this.memoryUsage -= removed.size;
      } else {
        break;
      }
    }
  }
  
  /**
   * 清理過期緩存
   */
  async cleanExpired() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [cid, data] of this.cache) {
      if (now - data.timestamp > this.config.cacheTTL && data.refs <= 1) {
        this.cache.delete(cid);
        this.memoryUsage -= data.size;
        cleaned++;
      }
    }
    
    console.log('[CID] Cleaned', cleaned, 'expired items');
    return cleaned;
  }
  
  /**
   * 保存引用計數到 IndexedDB
   */
  async saveRefs() {
    try {
      if (typeof db !== 'undefined') {
        await db.sync.put({ key: 'cid_refs', value: Object.fromEntries(this.refs) });
      }
    } catch (e) {
      console.error('[CID] Save refs error:', e);
    }
  }
  
  /**
   * 加載引用計數
   */
  async loadRefs() {
    try {
      if (typeof db !== 'undefined') {
        const record = await db.sync.get('cid_refs');
        if (record?.value) {
          this.refs = new Map(Object.entries(record.value));
        }
      }
    } catch (e) {
      console.error('[CID] Load refs error:', e);
    }
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    return {
      memoryItems: this.cache.size,
      memoryUsage: this.memoryUsage,
      networkItems: this.refs.size,
      maxMemory: this.config.maxMemoryCache,
      hitRate: this.calculateHitRate()
    };
  }
  
  /**
   * 計算命中率
   */
  calculateHitRate() {
    // 簡單實現
    return this.cache.size / Math.max(1, this.refs.size);
  }
  
  /**
   * 導出 CID 列表
   */
  exportCIDs() {
    return Array.from(this.refs.keys());
  }
  
  /**
   * 獲取內容信息
   */
  async stat(cid) {
    const cached = this.cache.get(cid);
    if (cached) {
      return {
        cid,
        size: cached.size,
        timestamp: cached.timestamp,
        local: true
      };
    }
    
    const inOPFS = await this.existsInOPFS(cid);
    if (inOPFS) {
      return {
        cid,
        size: 'unknown',
        timestamp: null,
        local: true,
        opfs: true
      };
    }
    
    return {
      cid,
      local: false,
      providers: this.providers?.get(cid) || null
    };
  }
}

// 導出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CIDStorage };
}
