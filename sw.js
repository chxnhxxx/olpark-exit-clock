const CACHE = 'olpark-exit-clock-v34';
const SHELL = ['./', './index.html', './assets/pretendard.woff2', './data2024.js', './venues.js', './recent.js', './park-schedule.js', './engine.js', './exit-profile.js', './venue-params.json', './calendar.js', './flow-chart.js', './app.js', './style.css', './hero.webp', './icon.svg', './assets/icon-192.png', './assets/icon-512.png', './manifest.json', './schedule.json', './records/index.json', './records/2025-12-06.json'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    (key.startsWith('olpark-exit-clock-') || /^olpark-v\d+$/.test(key)) && key !== CACHE
  ).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.href.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = event.request.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : event.request;
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') await cache.put(key, response.clone());
      return response;
    } catch {
      return await cache.match(key) || Response.error();
    }
  })());
});
