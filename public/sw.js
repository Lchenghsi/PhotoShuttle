/* 简单传 Service Worker：静态外壳缓存 + /api 直连 + exe 未运行时的离线提示页 */
/* 缓存名里的占位符由打包脚本替换为构建时间戳（源码运行时是固定名，改前端后需手动改名或 Ctrl+F5） */
const CACHE = 'jiandanchuan-shell-v__BUILD__';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;       // 跨域不管
  if (url.pathname.startsWith('/api/')) return;     // API 一律直连，失败即离线态
  if (e.request.mode === 'navigate') {
    // 页面导航：优先网络，服务挂了给友好提示页
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
    return;
  }
  // 静态资源：缓存优先
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
