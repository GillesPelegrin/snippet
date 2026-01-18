const CACHE_NAME = 'snippet-keeper-v1';
const ASSETS = [
    './',
    './index.html',
    './stylesheet.css',
    './script.js',
    './icon.svg'
];

// 1. Install Service Worker & Cache Assets
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

// 2. Serve from Cache (Offline Support)
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // 1. Is this an external image request? (Basic check)
    // We check if it's an image AND it's not from our own app
    if (e.request.destination === 'image' && !url.origin.includes(self.location.origin)) {
        e.respondWith(
            caches.open(IMAGE_CACHE).then(cache => {
                return cache.match(e.request).then(response => {
                    // Return cached image if found, otherwise fetch from net
                    return response || fetch(e.request).then(networkResponse => {
                        // Save a copy to cache for next time
                        cache.put(e.request, networkResponse.clone());
                        return networkResponse;
                    });
                });
            })
        );
        return;
    }

    // 2. Standard App Shell Strategy (Stays the same)
    e.respondWith(
        caches.match(e.request).then((response) => response || fetch(e.request))
    );
});