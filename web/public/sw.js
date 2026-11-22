/* Family Tab offline shell. The Vite build stamps these two declarations. */
const BUILD_ID = "__FAMILY_TAB_BUILD_ID__";
const ASSETS = /* __FAMILY_TAB_ASSETS__ */ [];
const PREFIX = "family-tab-shell-";
const CACHE = PREFIX + BUILD_ID;
const SHELL = ["/index.html", "/manifest.webmanifest", "/icon.svg", ...ASSETS];
const NAVIGATION_TIMEOUT_MS = 3000;

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
    const cache = caches.open(CACHE);
    const network = fetch(request).catch(() => null);
    event.waitUntil(network.then(async response => {
      if (!response?.ok || response.redirected || !response.headers.get("Content-Type")?.startsWith("text/html")) return;
      const copy = response.clone();
      // Keep this cache usable offline with the assets installed by this worker.
      if ((await response.clone().text()).includes(`<meta name="family-tab-build" content="${BUILD_ID}">`)) {
        await (await cache).put("/index.html", copy);
      } else {
        void copy.body?.cancel();
      }
    }).catch(() => undefined));
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
    });
    event.respondWith(Promise.race([network, deadline]).then(async response => {
      clearTimeout(timer);
      return response ?? (await (await cache).match("/index.html")) ?? Response.error();
    }));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(url.pathname)) ?? fetch(request),
    ));
  }
});
