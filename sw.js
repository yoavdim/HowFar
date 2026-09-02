const CACHE_NAME = 'howfar-cache-v4';

const CACHE_ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './toronto_data.json',
    './toronto_events.json',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon.png'
];

// Install Event
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(CACHE_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate Event - Clean up old caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Event - Stale While Revalidate
self.addEventListener('fetch', (e) => {
    // Only cache GET requests
    if (e.request.method !== 'GET') return;
    
    // Do not cache external APIs (like OpenMeteo or Bike Share)
    // Only cache local assets and leaflet/fontawesome CDN
    const url = new URL(e.request.url);
    if (!url.origin.includes(location.origin) && 
        !url.origin.includes('unpkg.com') && 
        !url.origin.includes('cdnjs.cloudflare.com') &&
        !url.origin.includes('cartocdn.com')) {
        return;
    }

    e.respondWith(
        caches.match(e.request).then(cachedResponse => {
            const networkFetch = fetch(e.request).then(networkResponse => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(e.request, responseClone);
                    });
                }
                return networkResponse;
            }).catch(err => {
                // Ignore network errors since we might be offline
                console.warn('Network fetch failed for', e.request.url, err);
            });

            // Return cached response immediately if available, otherwise wait for network
            return cachedResponse || networkFetch;
        })
    );
});
