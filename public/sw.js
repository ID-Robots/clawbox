// ClawBox Service Worker — a kill switch.
//
// Earlier builds registered this file and cached `/_next/static/*` and the
// `/` document cache-first under a fixed cache name. Nothing registers a
// service worker any more, but a browser that once did keeps the old worker
// in charge until a NEW /sw.js replaces it — and until now /sw.js redirected
// to /login for the worker's update check, which browsers treat as "no
// update". The result was a desktop that kept showing the previous build
// after every deploy ("app not refreshing").
//
// This worker exists only to replace that one. It takes over immediately,
// deletes every cache the old worker left behind, unregisters itself, and
// reloads the open pages so they load straight from the server. After that
// the browser has no worker and nothing caches the app shell.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
      await self.registration.unregister()
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      await Promise.all(clients.map((client) => client.navigate(client.url).catch(() => undefined)))
    })()
  )
})

// No fetch handler: nothing is intercepted, nothing is cached.
