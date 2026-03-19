/**
 * CID Resolver - 內容尋址存儲系統
 * 
 * 技術實現：
 * - SHA-256 內容哈希作為 CID
 * - 本地 OPFS 緩存
 * - DHT 風格的分佈式查找
 * - 圖片去重與永久鏈接
 * 
 * 使用方式：
 * const cid = await CIDResolver.hash(blob);
 * await CIDResolver.save(itemId, blob);
 * const blob = await CIDResolver.load(cid);
 */

const CIDResolver = {
  // CID 前綴
  PREFIX: 'qm1-',
  
  // 本地存儲映射
  cidMap: new Map(),      // cid -> { blob, itemId, timestamp }
  itemToCid: new Map(),   // itemId -> cid
  
  /**
   * 生成內容哈希 (CID)
   * 使用 SHA-256，結果作為 multiformat 風格 CID
   */
  async hash(blob) {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    // multibase 風格編碼 (base36)
    return this.PREFIX + this.base36Encode(hashHex);
  }
  
  /**
   * 將十六進制字符串編碼為 base36
   */
  base36Encode(hex) {
    const num = BigInt('0x' + hex);
    return num.toString(36);
  }
  
  /**
   * 從 base36 解碼回十六進制
   */
  base36Decode(base36) {
    const num = BigInt(base36);
    return num.toString(16).padStart(64, '0'); // SHA-256 = 64 hex chars
  }
  
  /**
   * 保存圖片並返回 CID
   */
  async save(itemId, blob) {
    const cid = await this.hash(blob);
    
    // 檢查是否已存在 (去重)
    if (this.cidMap.has(cid)) {
      console.log('[CID] Content already exists:', cid);
      this.itemToCid.set(itemId, cid);
      return cid;
    }
    
    // 存儲到內存映射
    this.cidMap.set(cid, {
      blob,
      itemId,
      timestamp: Date.now(),
      size: blob.size
    });
    
    // 存儲到 OPFS (持久化)
    await this.saveToOPFS(cid, blob);
    
    // 建立 itemId 到 CID 的映射
    this.itemToCid.set(itemId, cid);
    
    console.log('[CID] Saved:', cid, 'for item:', itemId);
    return cid;
  }
  
  /**
   * 通過 CID 加載圖片
   */
  async load(cid) {
    // 1. 先檢查內存
    const cached = this.cidMap.get(cid);
    if (cached) {
      console.log('[CID] Loaded from memory:', cid);
      return cached.blob;
    }
    
    // 2. 檢查 OPFS
    const opfsBlob = await this.loadFromOPFS(cid);
    if (opfsBlob) {
      // 還原到內存
      this.cidMap.set(cid, {
        blob: opfsBlob,
        timestamp: Date.now()
      });
      console.log('[CID] Loaded from OPFS:', cid);
      return opfsBlob;
    }
    
    // 3. 通過 DHT 請求網絡
    console.log('[CID] Requesting from network:', cid);
    return this.requestFromNetwork(cid);
  }
  
  /**
   * 通過 itemId 加載圖片
   */
  async loadByItemId(itemId) {
    const cid = this.itemToCid.get(itemId);
    if (!cid) {
      console.warn('[CID] No CID for item:', itemId);
      return null;
    }
    return this.load(cid);
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
      const fileHandle = await dir.getFileHandle('cid_' + cid);
      const file = await fileHandle.getFile();
      return new Blob([await file.arrayBuffer()], { type: 'image/jpeg' });
    } catch (e) {
      return null;
    }
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
      const fileHandle = await dir.getFileHandle('cid_' + cid, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(await blob.arrayBuffer());
      await writable.close();
      
      console.log('[CID] Saved to OPFS:', cid);
      return true;
    } catch (e) {
      console.error('[CID] OPFS save error:', e);
      return false;
    }
  }
  
  /**
   * 從網絡請求 (DHT 風格)
   * 向已知節點廣播請求
   */
  async requestFromNetwork(cid) {
    // 這個方法需要與 P2P 網絡集成
    // 廣播請求到所有鄰居，誰有這個 CID 就返回
    
    return new Promise((resolve) => {
      // 設置超時
      setTimeout(() => {
        console.warn('[CID] Network request timeout:', cid);
        resolve(null);
      }, 10000);
      
      // 通過 WebRTC 廣播請求
      if (this.broadcastRequest) {
        this.broadcastRequest(cid);
      }
    });
  }
  
  /**
   * 處理網絡傳入的 CID 請求
   */
  handleNetworkRequest(cid, peerId) {
    const cached = this.cidMap.get(cid);
    if (cached) {
      // 回應請求
      if (this.respondToRequest) {
        this.respondToRequest(peerId, cid, cached.blob);
      }
    }
  }
  
  /**
   * 獲取所有本地 CID
   */
  getLocalCIDs() {
    return Array.from(this.cidMap.keys());
  }
  
  /**
   * 獲取 CID 統計
   */
  getStats() {
    let totalSize = 0;
    for (const [cid, data] of this.cidMap) {
      totalSize += data.size || 0;
    }
    
    return {
      totalCIDs: this.cidMap.size,
      totalSize,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2)
    };
  }
  
  /**
   * 清理過期緩存 (7天)
   */
  async cleanExpired(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [cid, data] of this.cidMap) {
      if (now - data.timestamp > maxAgeMs) {
        this.cidMap.delete(cid);
        cleaned++;
      }
    }
    
    console.log('[CID] Cleaned', cleaned, 'expired entries');
    return cleaned;
  }
  
  /**
   * 導出 CID 數據庫 (用於節點同步)
   */
  exportCIDList() {
    const list = [];
    for (const [cid, data] of this.cidMap) {
      list.push({
        cid,
        itemId: data.itemId,
        timestamp: data.timestamp,
        size: data.size
      });
    }
    return list;
  }
};

// 導出模塊
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CIDResolver };
}
