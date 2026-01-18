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
    e.respondWith(
        caches.match(e.request).then((response) => response || fetch(e.request))
    );
});