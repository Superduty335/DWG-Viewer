// Offline cache for the installed web app: app shell, parsers and the DWG engine.
const CACHE = "dwgfield-v1";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon.svg", "fonts.css", "vendor/dxf-json.mjs",
  "vendor/libredwg/dist/libredwg-web.js", "vendor/libredwg/wasm/libredwg-web.js", "vendor/libredwg/wasm/libredwg-web.wasm"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && new URL(e.request.url).origin === location.origin) {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match("index.html"))));
});
