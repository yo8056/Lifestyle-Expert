/* 鍋貼小所 PWA service worker
   只處理鍋貼小所頁面自己的檔案；同一網域下的其他頁面（例如午餐選擇器 index.html）完全不攔截。 */
const CACHE = 'guotie-v2';
const ASSETS = [
  './index2.html',
  './manifest.webmanifest',
  './images/hero-poster.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];
const ASSET_URLS = ASSETS.map(p => new URL(p, self.location).href);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('guotie-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  url.search = '';
  if (!ASSET_URLS.includes(url.href)) return;          // 不是鍋貼小所的檔案就放行
  // 網路優先：有網路拿最新版並更新快取；離線時用快取
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.href, copy)); }
      return res;
    }).catch(() => caches.match(url.href))
  );
});
