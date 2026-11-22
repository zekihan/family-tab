/* Family Tab offline shell. The Vite build stamps these two declarations. */
const BUILD_ID = "__FAMILY_TAB_BUILD_ID__";
const ASSETS = /* __FAMILY_TAB_ASSETS__ */ [];
const PREFIX = "family-tab-shell-";
const CACHE = PREFIX + BUILD_ID;
const SHELL = ["/index.html", "/manifest.webmanifest", "/icon.svg", ...ASSETS];
const NAVIGATION_TIMEOUT_MS = 3000;
const SHELL_TYPES = {
  html: ["text/html"],
  js: ["text/javascript", "application/javascript", "application/x-javascript", "text/ecmascript", "application/ecmascript"],
  css: ["text/css"],
  webmanifest: ["application/manifest+json", "application/json"],
  json: ["application/json"],
  svg: ["image/svg+xml"],
};

function isShellResponse(path, response) {
  const type = (response.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
  return response.ok && response.status !== 206 && !response.redirected && response.body !== null &&
    !response.headers.has("Content-Range") && SHELL_TYPES[path.split(".").at(-1)]?.includes(type);
}

async function isMatchingShell(response) {
  return isShellResponse("/index.html", response) &&
    (await response.clone().text()).includes(`<meta name="family-tab-build" content="${BUILD_ID}">`);
}

async function installShell() {
  const request = path => new Request(path, { cache: "reload", credentials: "omit", redirect: "error" });
  const [index, ...assets] = SHELL;
  const response = await fetch(request(index));
  if (!await isMatchingShell(response)) throw new Error("The app shell does not match the service worker.");
  const responses = await Promise.all(assets.map(async path => {
    const asset = await fetch(request(path));
    if (!isShellResponse(path, asset)) throw new Error(`Invalid shell response for ${path}.`);
    return [path, asset];
  }));
  const cache = await caches.open(CACHE);
  try {
    for (const [path, asset] of responses) await cache.put(path, asset);
    await cache.put(index, response);
  } catch (error) {
    // Cache.put reads the entire body and can fail after earlier files were written.
    await caches.delete(CACHE);
    throw error;
  }
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
