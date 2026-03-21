/**
 * P2P Image Loader - Unified API
 * 
 * 簡化版：直接在 Vanilla JS 中使用的 Helper
 * 
 * 使用方式：
 * const url = await P2PImageLoader.get(item.imageHash);
 * if (url) img.src = url;
 */

const P2PImageLoader = {
  // 緩存已生成的 Object URL
  _urlCache: new Map(),
  
  /**
   * 通過 Hash 獲取圖片 Object URL
   */
  async get(imageHash) {
    if (!imageHash) return null;
    
    // 檢查緩存
    if (this._urlCache.has(imageHash)) {
      return this._urlCache.get(imageHash);
    }
    
    try {
      // 從 IndexedDB 查詢
      const blobs = await db.blobs.where('hash').equals(imageHash).toArray();
      
      if (blobs.length > 0 && blobs[0].blob) {
        const url = URL.createObjectURL(blobs[0].blob);
        this._urlCache.set(imageHash, url);
        console.log('[P2PImageLoader] Loaded:', imageHash);
        return url;
      }
      
      console.log('[P2PImageLoader] Not found:', imageHash);
      return null;
    } catch (e) {
      console.error('[P2PImageLoader] Error:', e);
      return null;
    }
  },
  
  /**
   * 為多個 item 批量加載圖片
   */
  async loadForItems(items) {
    const results = new Map();
    
    for (const item of items) {
      if (item.imageHash) {
        const url = await this.get(item.imageHash);
        if (url) {
          results.set(item.id, url);
        }
      }
    }
    
    return results;
  },
  
  /**
   * 清理所有緩存的 URL
   */
  clearCache() {
    for (const url of this._urlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this._urlCache.clear();
  }
};

// 全局註冊
window.P2PImageLoader = P2PImageLoader;
