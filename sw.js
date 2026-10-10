// すべてネットワーク優先。圏外のときだけ前回保存した内容を使う
const CACHE = 'shorts-v3';
const SHELL = ['./', 'index.html', 'policy.html', 'classify.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'data/videos.json', 'data/synonyms.json', 'data/categories.json', 'data/category-overrides.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
