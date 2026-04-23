const CACHE = "delicias-pwa-v24";
const PRECACHE = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isMenuJsonRequest(url) {
  return url.href.includes("delicia-menu") && url.pathname.endsWith("menu.json");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  /* Red primero: así cada deploy se ve sin quedar atrapado en app.js/index viejos. */
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy).catch(() => {}));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  if (isMenuJsonRequest(url)) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((c) => c || new Response("[]", { headers: { "Content-Type": "application/json" } })))
    );
    return;
  }

  /* Imágenes del menú: sin interceptar — evita caché del SW que rompa <img> cross-origin. */
});
