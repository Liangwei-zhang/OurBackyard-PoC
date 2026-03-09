// Service Worker for P2P Offline App Updates
const CACHE_NAME = 'ourbackyard-v1';
const DB_NAME = 'OurBackyardDB';

// Open IndexedDB
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 3);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('systemAssets')) {
                db.createObjectStore('systemAssets', { keyPath: 'url' });
            }
        };
    });
}

// Fetch app bundle from IndexedDB
async function getBundle(url) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('systemAssets', 'readonly');
        const store = tx.objectStore('systemAssets');
        const request = store.get(url);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Service Worker Fetch Handler
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Only intercept same-origin HTML/JS/CSS requests
    if (url.origin === location.origin && 
        (url.pathname.endsWith('.html') || 
         url.pathname.endsWith('.js') || 
         url.pathname.endsWith('.css') ||
         url.pathname === '/')) {
        
        event.respondWith(
            (async () => {
                try {
                    // Try to get from IndexedDB first
                    const asset = await getBundle(url.pathname);
                    if (asset && asset.blob) {
                        console.log('[SW] Serving from IndexedDB:', url.pathname);
                        return new Response(asset.blob, {
                            headers: { 
                                'Content-Type': getContentType(url.pathname),
                                'Cache-Control': 'no-store'
                            }
                        });
                    }
                } catch (e) {
                    console.log('[SW] DB fetch failed:', e.message);
                }
                
                // Fallback to network
                console.log('[SW] Falling back to network:', url.pathname);
                return fetch(event.request);
            })()
        );
    }
});

function getContentType(pathname) {
    if (pathname.endsWith('.html')) return 'text/html';
    if (pathname.endsWith('.js')) return 'application/javascript';
    if (pathname.endsWith('.css')) return 'text/css';
    return 'text/html';
}

// Handle messages from main app
self.addEventListener('message', (event) => {
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// Activate immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

console.log('[SW] OurBackyard Service Worker loaded');
