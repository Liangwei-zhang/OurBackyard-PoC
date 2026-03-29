/**
 * P2PImage Component - Content-Addressable Image Loader
 * 
 * 使用方式：
 * <P2PImage imageHash={item.imageHash} />
 * 
 * 特性：
 * - 純 Hash 驅動，內容定義身份
 * - 自動從 IndexedDB 加載 Blob
 * - 自動生成 Object URL
 * - 加載失敗時顯示佔位符
 */

class P2PImage extends HTMLElement {
  static get observedAttributes() {
    return ['imagehash', 'placeholder', 'alt'];
  }
  
  constructor() {
    super();
    this._imageHash = null;
    this._objectUrl = null;
    this._loading = false;
  }
  
  connectedCallback() {
    this.render();
    this.loadImage();
  }
  
  disconnectedCallback() {
    // 清理 Object URL 內存
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
    }
  }
  
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      if (name === 'imagehash') {
        this._imageHash = newValue;
        this.loadImage();
      } else if (name === 'placeholder') {
        this.render();
      }
    }
  }
  
  get imageHash() {
    return this._imageHash;
  }
  
  set imageHash(value) {
    this._imageHash = value;
    if (this._imageHash) {
      this.setAttribute('imagehash', value);
    }
    this.loadImage();
  }
  
  async loadImage() {
    if (!this._imageHash || this._loading) return;
    
    this._loading = true;
    this.renderLoading();
    
    try {
      // 從 IndexedDB 通過 Hash 查詢
      const db = window.ourBackyardDB;
      if (!db) {
        console.warn('[P2PImage] DB not initialized');
        this.renderPlaceholder();
        return;
      }
      
      const blobs = await db.blobs.where('hash').equals(this._imageHash).toArray();
      
      if (blobs.length > 0 && blobs[0].blob) {
        // 創建 Blob 和 Object URL
        const blob = blobs[0].blob;
        
        // 清理舊的 URL
        if (this._objectUrl) {
          URL.revokeObjectURL(this._objectUrl);
        }
        
        this._objectUrl = URL.createObjectURL(blob);
        this.renderImage(this._objectUrl);
        console.log('[P2PImage] Loaded:', this._imageHash);
      } else {
        // Hash 對應的圖片不存在，可能還在 P2P 傳輸中
        console.log('[P2PImage] Not found:', this._imageHash);
        this.renderPlaceholder();
      }
    } catch (e) {
      console.error('[P2PImage] Error:', e);
      this.renderPlaceholder();
    }
    
    this._loading = false;
  }
  
  render() {
    this.style.display = 'inline-block';
    this.style.backgroundColor = '#333';
    this.style.borderRadius = '8px';
  }
  
  renderLoading() {
    this.innerHTML = `
      <div style="
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        min-height: 100px;
        color: #666;
      ">
        <span>⏳ Loading...</span>
      </div>
    `;
  }
  
  renderPlaceholder() {
    const placeholder = this.getAttribute('placeholder') || '📷';
    const alt = this.getAttribute('alt') || 'Image';
    
    this.innerHTML = `
      <div style="
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        min-height: 100px;
        background: linear-gradient(135deg, #444 0%, #333 100%);
        border-radius: 8px;
        font-size: 32px;
      " title="Image not available (P2P sync in progress)">
        ${placeholder}
      </div>
    `;
  }
  
  renderImage(url) {
    this.innerHTML = `
      <img 
        src="${url}" 
        alt="${this.getAttribute('alt') || 'P2P Image'}"
        style="
          width: 100%;
          height: 100%;
          object-fit: cover;
          border-radius: 8px;
        "
        onerror="this.parentNode.renderPlaceholder()"
      />
    `;
  }
}

// 註冊 Web Component
customElements.define('p2p-image', P2PImage);

// ====== React 版本 ======
/**
 * React Hook 版本
 * 
 * 使用方式：
 * const imageUrl = useP2PImage(imageHash);
 * return <img src={imageUrl} />;
 */

function useP2PImage(imageHash, options = {}) {
  const [imageUrl, setImageUrl] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  
  React.useEffect(() => {
    if (!imageHash) {
      setImageUrl(null);
      return;
    }
    
    let cancelled = false;
    setLoading(true);
    setError(null);
    
    async function loadImage() {
      try {
        const db = window.ourBackyardDB;
        if (!db) {
          if (!cancelled) setError('DB not initialized');
          return;
        }
        
        const blobs = await db.blobs.where('hash').equals(imageHash).toArray();
        
        if (!cancelled && blobs.length > 0 && blobs[0].blob) {
          const url = URL.createObjectURL(blobs[0].blob);
          setImageUrl(url);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    
    loadImage();
    
    return () => {
      cancelled = true;
    };
  }, [imageHash]);
  
  return { imageUrl, loading, error };
}

/**
 * React 組件版本
 * 
 * 使用方式：
 * <P2PImageReact imageHash={item.imageHash} placeholder="📷" />
 */

function P2PImageReact({ imageHash, placeholder = '📷', alt = '', className = '', style = {} }) {
  const { imageUrl, loading, error } = useP2PImage(imageHash);
  const el = React.createElement;
  
  if (loading) {
    return el(
      'div',
      {
        className,
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#333',
          borderRadius: '8px',
          minHeight: '100px',
          ...style
        }
      },
      el('span', { style: { color: '#666' } }, '⏳')
    );
  }
  
  if (!imageUrl) {
    return el(
      'div',
      {
        className,
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #444 0%, #333 100%)',
          borderRadius: '8px',
          fontSize: '32px',
          minHeight: '100px',
          ...style
        },
        title: error || 'Image not available (P2P sync in progress)'
      },
      placeholder
    );
  }
  
  return el('img', {
    src: imageUrl,
    alt,
    className,
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      borderRadius: '8px',
      ...style
    }
  });
}

// 導出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { P2PImage, useP2PImage, P2PImageReact };
}
