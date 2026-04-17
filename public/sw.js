// ClawBox Service Worker — PWA installability + asset caching
//
// Bumping CACHE_NAME here is the supported way to invalidate previously
// cached assets on existing installs — the `activate` handler deletes any
// cache whose name doesn't match, so users get a clean slate on next visit.
const CACHE_NAME = 'clawbox-v3'
const PRECACHE = [
  '/',
  '/icon-192.png',
  '/icon-512.png',
  '/clawbox-icon.png',
  '/clawbox-logo.png',
  '/clawbox-crab.png',
  '/clawbox-wallpaper.jpeg',
  '/fonts/material-symbols-rounded.ttf',
]

// Static asset extensions to cache
const CACHEABLE_EXT = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      let cache = await caches.open(CACHE_NAME)
      try {
        await cache.addAll(PRECACHE)
      } catch {
        // addAll is atomic — on failure the cache may be in a partial state.
        // Wipe and retry per-URL so we tolerate individual missing assets.
        await caches.delete(CACHE_NAME)
        cache = await caches.open(CACHE_NAME)
        await Promise.allSettled(PRECACHE.map((url) => cache.add(url).catch(() => undefined)))
      }
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Skip non-GET and API requests
  if (event.request.method !== 'GET') return
  if (url.pathname.startsWith('/setup-api/') || url.pathname.startsWith('/api/')) return

  // Static assets: cache-first strategy
  if (CACHEABLE_EXT.test(url.pathname) || url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        }).catch(() => cached || Response.error())
      })
    )
    return
  }

  // HTML/pages: network-first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        }
        return response
      })
      .catch(() => caches.match(event.request))
  )
})
