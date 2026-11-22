/* Family Tab offline shell. The Vite build stamps these two declarations. */
const BUILD_ID = "__FAMILY_TAB_BUILD_ID__";
const ASSETS = /* __FAMILY_TAB_ASSETS__ */ [];
const PREFIX = "family-tab-shell-";
const CACHE = PREFIX + BUILD_ID;
const SHELL = ["/index.html", "/manifest.webmanifest", "/icon.svg", ...ASSETS];
const NAVIGATION_TIMEOUT_MS = 3000;

async function isMatchingShell(response) {
  return response.ok && response.status !== 206 && !response.redirected &&
    /^text\/html(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "") &&
    (await response.clone().text()).includes(`<meta name="family-tab-build" content="${BUILD_ID}">`);
}

async function installShell() {
  const request = path => new Request(path, { cache: "reload", credentials: "omit" });
  const [index, ...assets] = SHELL;
  const response = await fetch(request(index));
  if (!await isMatchingShell(response)) throw new Error("The app shell does not match the service worker.");
  const cache = await caches.open(CACHE);
  await cache.addAll(assets.map(request));
  await cache.put(index, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(installShell());
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
    const controller = new AbortController();
    const network = fetch(request, { signal: controller.signal }).then(async response => {
      if (response.type === "opaqueredirect" || await isMatchingShell(response)) return response;
      return null;
    }).catch(() => null);
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
    });
    event.respondWith(Promise.race([network, deadline]).then(async response => {
      clearTimeout(timer);
      if (response) return response;
      controller.abort();
      return (await caches.match("/index.html", { cacheName: CACHE })) ?? Response.error();
    }));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(url.pathname)) ?? fetch(request),
    ));
  }
});
