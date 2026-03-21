/**
 * OurBackyard Service Worker — Offline-First
 * Caches all app files on install; serves from cache first.
 * Falls back to network only when cache miss occurs.
 */

const CACHE_NAME = 'ourbackyard-v13';

// All files required for full offline functionality
const APP_SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/ob-utils.js',
  '/p1p2-features.js',
  '/icon-192.png',
  '/icon-512.png',
  // Core JS libraries (local, no CDN)
  '/js/dexie.js',
  '/js/h3-js.js',
  '/js/secp256k1.js',
  '/js/db.js',
  '/js/utils.js',
  // Active native modules
  '/native/communication/p2p-mesh.js',
  '/native/communication/nostr-signaling.js',
  '/native/ui/chat-ui.js',
  '/native/security/key-vault.js',
  '/native/security/geo-consent.js',
  '/native/governance/wot-trust.js',
  '/native/ai/local-ai.js',
  '/native/desktop-full-node.js',
  '/legal.html',
];

// ── Install: cache all shell files ───────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing cache:', CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache files one by one — don't fail install if a single file errors
      return Promise.allSettled(
        APP_SHELL_FILES.map(url =>
          fetch(url, { cache: 'no-store' })
            .then(res => {
              if (res.ok) return cache.put(url, res);
              console.warn('[SW] Skip (not ok):', url, res.status);
            })
            .catch(err => console.warn('[SW] Skip (network):', url, err.message))
        )
      );
    }).then(() => {
      console.log('[SW] Shell cached, activating immediately');
      return self.skipWaiting();
    })
  );
});

// ── Activate: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_NAME)
        .map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first with network fallback ──────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin API/WebSocket requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Skip Nostr relay WebSocket connections (handled by app, not SW)
  if (url.protocol === 'wss:' || url.protocol === 'ws:') return;

  // Skip cross-origin (Nostr relays, STUN/TURN, analytics)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      // Not in cache — fetch from network and cache the response
      return fetch(request).then(response => {
        // Only cache successful same-origin responses
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      }).catch(() => {
        // Offline and not cached — return offline page for navigation
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});

// ── Background Sync stub ──────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-items') {
    console.log('[SW] Background sync triggered');
    // App handles sync via P2P mesh on reconnect
  }
});

// ── Push notifications stub ───────────────────────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'OurBackyard', body: 'New activity' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'OurBackyard', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'ourbackyard',
      data: data,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});
