/* Family Tab offline shell. The Vite build stamps these two declarations. */
const BUILD_ID = "__FAMILY_TAB_BUILD_ID__";
const ASSETS = /* __FAMILY_TAB_ASSETS__ */ [];
const PREFIX = "family-tab-shell-";
const CACHE = PREFIX + BUILD_ID;
const SHELL = ["/index.html", "/manifest.webmanifest", "/icon.svg", ...ASSETS];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path =>
    new Request(path, { cache: "reload", credentials: "omit" }),
  ))));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "activate") event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      /^\/(?:api|auth)(?:\/|$)/.test(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () =>
      (await (await caches.open(CACHE)).match("/index.html")) ?? Response.error(),
    ));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(url.pathname)) ?? fetch(request),
    ));
  }
});
