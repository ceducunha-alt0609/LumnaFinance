/**
 * FINFLOW — Service Worker
 * Estratégia: Cache-First para assets estáticos, Network-First para dados
 * Versão de cache atualizada força re-download de todos os assets
 */

const CACHE_NAME   = 'finflow-v2.0.0';
const STATIC_CACHE = 'finflow-static-v2.0.0';
const DATA_CACHE   = 'finflow-data-v2.0.0';

/* Assets que devem ser cacheados imediatamente no install */
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
];

/* CDN assets (cacheados sob demanda) */
const CDN_PATTERNS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
];

/* ── INSTALL: pré-cacheia assets críticos ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Install error:', err))
  );
});

/* ── ACTIVATE: limpa caches obsoletos ── */
self.addEventListener('activate', event => {
  const validCaches = [STATIC_CACHE, DATA_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !validCaches.includes(k))
          .map(k => {
            console.log('[SW] Removing old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});

/* ── FETCH: estratégia híbrida por tipo de recurso ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requisições não-GET e chrome-extension
  if (request.method !== 'GET' || url.protocol === 'chrome-extension:') return;

  // CDN assets → Cache-First (fontes e libs externas)
  if (CDN_PATTERNS.some(p => url.hostname.includes(p))) {
    event.respondWith(cacheFirst(request, DATA_CACHE));
    return;
  }

  // Assets locais → Cache-First com fallback de rede
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Outros → Network-First
  event.respondWith(networkFirst(request, DATA_CACHE));
});

/* Cache-First: serve do cache, atualiza em background */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    // Atualiza em background (stale-while-revalidate)
    fetch(request).then(fresh => {
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
    }).catch(() => {});
    return cached;
  }

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    return offlineFallback(request);
  }
}

/* Network-First: tenta rede, fallback para cache */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    return cached || offlineFallback(request);
  }
}

/* Fallback offline */
function offlineFallback(request) {
  if (request.destination === 'document') {
    return caches.match('./index.html');
  }
  return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
}

/* ── BACKGROUND SYNC: para envio futuro de dados ── */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-transactions') {
    event.waitUntil(syncTransactions());
  }
});

async function syncTransactions() {
  // Hook para integração futura com API backend
  console.log('[SW] Background sync: transactions');
}

/* ── PUSH NOTIFICATIONS: alertas financeiros ── */
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'FinFlow Alerta', {
      body:    data.body || 'Verificar painel financeiro',
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-192.png',
      tag:     'finflow-alert',
      renotify: true,
      data:    { url: data.url || './' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        const target = event.notification.data?.url || './';
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow(target);
      })
  );
});
