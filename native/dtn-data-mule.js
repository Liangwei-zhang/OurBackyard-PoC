/**
 * DTN Data Mule - 延遲容忍網絡與數據騾子
 * 
 * 利用用戶的物理移動軌跡實現跨區域數據傳遞
 * 
 * @version 1.0.0
 * @date 2026-03-08
 */

const EventEmitter = require('events');
const { createHash } = require('crypto');

// H3 庫 (簡化實現)
const H3 = {
  latLngToCell: (lat, lng, res = 9) => {
    // 簡化的 H3 網格計算
    const h = Math.floor((lat + 90) * 10000) * 100000 + Math.floor((lng + 180) * 10000);
    return `${res}${h}`;
  },
  cellToLatLng: (cell) => {
    // 逆運算
    const h = parseInt(cell.slice(1));
    const lat = (Math.floor(h / 100000) - 90) / 10000;
    const lng = (h % 100000 - 180) / 10000;
    return { lat, lng };
  },
  gridDisk: (cell, k) => {
    // 獲取鄰居網格
    return [cell]; // 簡化
  }
};

class DTNDataMule extends EventEmitter {
  constructor(libp2p, options = {}) {
    super();
    this.libp2p = libp2p;
    this.peerId = libp2p.peerId?.toString() || 'unknown';
    
    // 配置
    this.config = {
      h3Resolution: options.h3Resolution || 9,
      syncThreshold: options.syncThreshold || 1000, // 米
      routeChangeDebounce: options.routeChangeDebounce || 5000,
      maxMuleCapacity: options.maxMuleCapacity || 50, // 最大攜帶包裹數
      flushOnArrival: options.flushOnArrival || true
    };
    
    // 當前位置
    this.currentLocation = null;
    this.currentH3 = null;
    this.previousH3 = null;
    
    // 待轉發的包裹
    this.pendingPackages = new Map(); // h3 -> [packages]
    
    // 已轉發歷史
    this.flushHistory = [];
    
    // 位置追蹤
    this.locationHistory = [];
    
    // 監聽器
    this.watchId = null;
  }
  
  /**
   * 啟動位置追蹤
   */
  async startTracking() {
    if ('geolocation' in navigator) {
      this.watchId = navigator.geolocation.watchPosition(
        this._onLocationUpdate.bind(this),
        this._onLocationError.bind(this),
        {
          enableHighAccuracy: true,
          maximumAge: 30000,
          timeout: 10000
        }
      );
      
      // 初始位置
      navigator.geolocation.getCurrentPosition(
        pos => this._onLocationUpdate(pos),
        err => console.warn('[DTN] Initial location failed:', err)
      );
      
      console.log(`[DTN] Started tracking for ${this.peerId}`);
    } else {
      console.warn('[DTN] Geolocation not supported');
    }
  }
  
  /**
   * 位置更新處理
   */
  _onLocationUpdate(position) {
    const { latitude, longitude } = position.coords;
    const timestamp = Date.now();
    
    this.currentLocation = { lat: latitude, lng: longitude, timestamp };
    
    // 計算 H3 網格
    const newH3 = H3.latLngToCell(latitude, longitude, this.config.h3Resolution);
    
    // 記錄歷史
    this.locationHistory.push({
      lat: latitude,
      lng: longitude,
      h3: newH3,
      timestamp
    });
    
    // 保持歷史長度
    if (this.locationHistory.length > 100) {
      this.locationHistory.shift();
    }
    
    // 檢測網格變化
    if (this.currentH3 && newH3 !== this.currentH3) {
      this._onH3Change(this.currentH3, newH3);
    }
    
    this.currentH3 = newH3;
    
    // 廣播位置 (低頻)
    this._broadcastLocation(latitude, longitude, newH3);
  }
  
  /**
   * 位置錯誤處理
   */
  _onLocationError(error) {
    console.warn('[DTN] Location error:', error.message);
    this.emit('location:error', error);
  }
  
  /**
   * H3 網格變化處理
   */
  async _onH3Change(oldH3, newH3) {
    console.log(`[DTN] H3 changed: ${oldH3} -> ${newH3}`);
    
    this.previousH3 = oldH3;
    
    // 1. 檢查是否有需要轉發到新網格的包裹
    await this._checkAndFlush(newH3);
    
    // 2. 從新網格拉取需要轉發到其他地方的包裹
    await this._pullPendingPackages(newH3);
    
    // 3. 觸發事件
    this.emit('h3:change', { oldH3, newH3, peerId: this.peerId });
  }
  
  /**
   * 轉發包裹
   */
  async _checkAndFlush(targetH3) {
    const packages = this.pendingPackages.get(targetH3);
    if (!packages || packages.length === 0) return;
    
    console.log(`[DTN] Flushing ${packages.length} packages to ${targetH3}`);
    
    const flushed = [];
    
    for (const pkg of packages) {
      // 通過 BLE/Wi-Fi Direct 發送
      const success = await this._deliverPackage(pkg);
      if (success) {
        flushed.push(pkg.id);
      }
    }
    
    // 清除已轉發
    this.pendingPackages.delete(targetH3);
    
    // 記錄歷史
    this.flushHistory.push({
      timestamp: Date.now(),
      h3: targetH3,
      count: flushed.length
    });
    
    this.emit('packages:flushed', { h3: targetH3, count: flushed.length });
  }
  
  /**
   * 交付包裹
   */
  async _deliverPackage(pkg) {
    // 嘗試通過多種方式交付
    const deliveryMethods = [
      () => this._deliverViaBLE(pkg),
      () => this._deliverViaWiFiDirect(pkg),
      () => this._deliverViaPubSub(pkg)
    ];
    
    for (const method of deliveryMethods) {
      try {
        const result = await Promise.race([
          method(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        
        if (result) {
          console.log(`[DTN] Package ${pkg.id} delivered via ${result.method}`);
          return true;
        }
      } catch (e) {
        continue;
      }
    }
    
    return false;
  }
  
  /**
   * BLE 交付
   */
  async _deliverViaBLE(pkg) {
    // 模擬 BLE 傳輸
    // 實際實現需要 ble-wifi-direct.js 集成
    return { method: 'BLE', success: true };
  }
  
  /**
   * Wi-Fi Direct 交付
   */
  async _deliverViaWiFiDirect(pkg) {
    return { method: 'WiFiDirect', success: true };
  }
  
  /**
   * PubSub 交付 (最後手段)
   */
  async _deliverViaPubSub(pkg) {
    // 通過 GossipSub 廣告包裹可用性
    return { method: 'PubSub', success: true };
  }
  
  /**
   * 拉取待轉發包裹
   */
  async _pullPendingPackages(currentH3) {
    // 從鄰居獲取需要轉發的包裹
    const neighbors = H3.gridDisk(currentH3, 1);
    
    for (const h3 of neighbors) {
      // 查詢該網格是否有需要轉發的包裹
      const packages = await this._queryPackagesForH3(h3);
      
      if (packages.length > 0) {
        console.log(`[DTN] Pulled ${packages.length} packages from ${h3}`);
        
        // 存儲在本地
        for (const pkg of packages) {
          const targetH3 = pkg.targetH3;
          if (!this.pendingPackages.has(targetH3)) {
            this.pendingPackages.set(targetH3, []);
          }
          
          // 檢查容量
          if (this.pendingPackages.get(targetH3).length < this.config.maxMuleCapacity) {
            this.pendingPackages.get(targetH3).push(pkg);
          }
        }
      }
    }
  }
  
  /**
   * 查詢 H3 網格的包裹
   */
  async _queryPackagesForH3(h3) {
    // 實際實現需要從 DHT 或本地緩存查詢
    // 這裡返回空數組模擬
    return [];
  }
  
  /**
   * 廣播位置
   */
  _broadcastLocation(lat, lng, h3) {
    this.emit('location:update', {
      peerId: this.peerId,
      lat,
      lng,
      h3,
      timestamp: Date.now()
    });
  }
  
  /**
   * 創建跨網格 Dead Drop 包裹
   * @param {string} targetH3 - 目標網格
   * @param {Object} data - 數據
   * @param {number} ttl - 過期時間 (ms)
   */
  async createPackage(targetH3, data, ttl = 86400000) {
    const pkg = {
      id: createHash('sha256').update(Date.now() + this.peerId).digest('hex').slice(0, 16),
      sourceH3: this.currentH3,
      targetH3,
      data,
      createdAt: Date.now(),
      ttl,
      status: 'pending'
    };
    
    // 如果當前網格就是目標，直接交付
    if (targetH3 === this.currentH3) {
      await this._deliverPackage(pkg);
    } else {
      // 添加到待轉發
      if (!this.pendingPackages.has(targetH3)) {
        this.pendingPackages.set(targetH3, []);
      }
      this.pendingPackages.get(targetH3).push(pkg);
    }
    
    console.log(`[DTN] Created package ${pkg.id} -> ${targetH3}`);
    
    return pkg;
  }
  
  /**
   * 獲取運動模式 (開車/步行)
   */
  getMotionPattern() {
    if (this.locationHistory.length < 5) return 'unknown';
    
    const recent = this.locationHistory.slice(-10);
    
    // 計算速度
    let totalSpeed = 0;
    for (let i = 1; i < recent.length; i++) {
      const dist = this._distance(
        recent[i-1].lat, recent[i-1].lng,
        recent[i].lat, recent[i].lng
      );
      const time = (recent[i].timestamp - recent[i-1].timestamp) / 1000;
      totalSpeed += dist / time; // m/s
    }
    
    const avgSpeed = totalSpeed / (recent.length - 1);
    
    if (avgSpeed > 8) return 'driving';      // > 28 km/h
    if (avgSpeed > 1.4) return 'cycling';    // > 5 km/h
    if (avgSpeed > 0.3) return 'walking';    // > 1 km/h
    return 'stationary';
  }
  
  /**
   * 計算距離
   */
  _distance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // m
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  /**
   * 獲取統計
   */
  getStats() {
    return {
      peerId: this.peerId,
      currentH3: this.currentH3,
      motionPattern: this.getMotionPattern(),
      pendingPackages: Array.from(this.pendingPackages.values()).reduce((s, arr) => s + arr.length, 0),
      flushHistoryCount: this.flushHistory.length,
      locationHistoryLength: this.locationHistory.length
    };
  }
  
  /**
   * 停止追蹤
   */
  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
      console.log(`[DTN] Stopped tracking`);
    }
  }
}

module.exports = { DTNDataMule, H3 };
