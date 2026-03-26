// OurBackyard Service Worker v41
// 策略：App Shell 预缓存 + 动态资源 network-first + IndexedDB 数据离线可用

const APP_SHELL_VERSION = 'v41';
const CACHE_SHELL  = 'ob-shell-'  + APP_SHELL_VERSION;
const CACHE_ASSETS = 'ob-assets-' + APP_SHELL_VERSION;

// ── App Shell：安装时预缓存，确保离线可启动 ─────────────────────────────────
const APP_SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/sw.js',
  '/app/ob-utils.js',
  '/app/p1p2-features.js',
  '/js/dexie.js',
  '/js/h3-js.js',
  '/js/utils.js',
  '/js/db.js',
  '/js/ob-sdk.js',
  '/js/secp256k1.js',
  '/native/ui/chat-ui.js',
  '/native/ai/local-ai.js',
  '/native/governance/wot-trust.js',
  '/native/desktop-full-node.js',
  '/native/security/key-vault.js',
  '/native/security/geo-consent.js',
];

// ── 这些文件每次都走网络（动态内容 / 频繁变更）─────────────────────────────
const NEVER_CACHE = [
  '/server.log',
  '/uploads/',
];

// ── Install：预缓存 App Shell，跳过等待 ──────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_SHELL).then(cache => {
      // addAll 会原子性失败；对每个文件单独 fetch 避免一个 404 阻断全部
      return Promise.all(
        APP_SHELL_FILES.map(url =>
          fetch(url, { cache: 'no-store' })
            .then(res => {
              if (res.ok) return cache.put(url, res);
              console.warn('[SW] Shell precache skip (not ok):', url, res.status);
            })
            .catch(err => console.warn('[SW] Shell precache skip (err):', url, err.message))
        )
      );
    }).then(() => console.log('[SW] ' + APP_SHELL_VERSION + ' installed, shell cached'))
  );
});

// ── Activate：清旧缓存 + 立即接管 ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(n => n !== CACHE_SHELL && n !== CACHE_ASSETS)
          .map(n => {
            console.log('[SW] Deleting old cache:', n);
            return caches.delete(n);
          })
      )
    ).then(() => self.clients.claim())
     .then(() => console.log('[SW] ' + APP_SHELL_VERSION + ' activated'))
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // Skip chrome-extension, devtools, external analytics etc.
  if (url.origin !== self.location.origin) return;

  // Never-cache paths
  if (NEVER_CACHE.some(p => url.pathname.startsWith(p))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Navigate (HTML) → shell-first, then network update in background
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html', { cacheName: CACHE_SHELL })
        .then(cached => {
          const networkFetch = fetch(event.request, { cache: 'no-store' })
            .then(res => {
              if (res.ok) {
                caches.open(CACHE_SHELL).then(c => c.put('/index.html', res.clone()));
              }
              return res;
            })
            .catch(() => null);

          // Respond with cache immediately; update happens behind the scenes
          return cached || networkFetch;
        })
    );
    return;
  }

  // App Shell JS/CSS/icons → cache-first (fast), network fallback, background update
  const isShell = APP_SHELL_FILES.includes(url.pathname);
  if (isShell) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const networkFetch = fetch(event.request, { cache: 'no-store' })
          .then(res => {
            if (res.ok) {
              caches.open(CACHE_SHELL).then(c => c.put(event.request, res.clone()));
            }
            return res;
          })
          .catch(() => null);

        return cached || networkFetch;
      })
    );
    return;
  }

  // Everything else (fonts, CDN, API calls) → network-first, cache fallback
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_ASSETS).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Background Sync：发布商品离线队列 ────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-items') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'BG_SYNC_ITEMS' }));
      })
    );
  }
});

// ── Push Notifications（预留）────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'OurBackyard', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'OurBackyard', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'ob-push',
      data: data,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(c => c.url.includes(self.location.origin));
        if (existing) return existing.focus();
        return self.clients.openWindow('/');
      })
  );
});
