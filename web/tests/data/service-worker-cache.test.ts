import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const BUILD = "build-1";
const ORIGIN = "https://ledger.example";
const ASSETS = ["/assets/app.js", "/assets/app.css"];
const SHELL = ["/index.html", "/manifest.webmanifest", "/icon.svg", ...ASSETS];

class ShellRequest extends Request {
  constructor(input: string, init?: RequestInit) {
    super(input.startsWith("/") ? new URL(input, ORIGIN) : input, init);
  }
}

class NavigateRequest extends ShellRequest {
  override get mode(): RequestMode {
    return "navigate";
  }
}

function worker() {
  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8")
    .replaceAll("__FAMILY_TAB_BUILD_ID__", BUILD)
    .replace("/* __FAMILY_TAB_ASSETS__ */ []", JSON.stringify(ASSETS));
  const puts: string[] = [];
  const fetches: string[] = [];
  const buckets = new Map<string, Map<string, Response>>();
  const bodies = new Map<string, { body: string; type: string; status?: number }>([
    ["/index.html", { body: `<!doctype html><meta name="family-tab-build" content="${BUILD}">`, type: "text/html" }],
    ["/manifest.webmanifest", { body: "{}", type: "application/manifest+json" }],
    ["/icon.svg", { body: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", type: "image/svg+xml" }],
    ["/assets/app.js", { body: "console.log('shell')", type: "text/javascript" }],
    ["/assets/app.css", { body: "body{}", type: "text/css" }],
    ["/api/snapshot", { body: "{\"revision\":1}", type: "application/json" }],
    ["/api/sync/ops", { body: "{\"results\":[]}", type: "application/json" }],
    ["/api/sync/receipts", { body: "{\"receipts\":[]}", type: "application/json" }],
    ["/auth/login", { body: "<!doctype html>login", type: "text/html" }],
    ["/healthz", { body: "ok", type: "text/plain" }],
    ["/mcp", { body: "{}", type: "application/json" }],
    ["/.well-known/oauth-protected-resource", { body: "{}", type: "application/json" }],
  ]);

  const caches = {
    async open(name: string) {
      const bucket = buckets.get(name) ?? new Map<string, Response>();
      buckets.set(name, bucket);
      return {
        async put(key: string, response: Response) {
          puts.push(key);
          bucket.set(key, response);
        },
        async match(key: string) {
          // Cache.match returns a fresh body on every hit.
          return bucket.get(key)?.clone();
        },
      };
    },
    async keys() {
      return [...buckets.keys()];
    },
    async delete(name: string) {
      return buckets.delete(name);
    },
    async match(key: string, options?: { cacheName?: string }) {
      return buckets.get(options?.cacheName ?? "")?.get(key)?.clone();
    },
  };

  const self = Object.assign(new EventTarget(), {
    location: new URL(`${ORIGIN}/`),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  });
  const fetch = async (input: Request) => {
    const url = new URL(input.url);
    fetches.push(`${input.method} ${url.pathname}`);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const found = bodies.get(path);
    if (!found) return new Response("missing", { status: 404, headers: { "Content-Type": "text/plain" } });
    return new Response(found.body, {
      status: found.status ?? 200,
      headers: { "Content-Type": found.type },
    });
  };
  new Function("self", "caches", "fetch", "Request", source)(self, caches, fetch, ShellRequest);

  function extendable(type: string) {
    return Object.assign(new Event(type), {
      waits: [] as Promise<unknown>[],
      waitUntil(promise: Promise<unknown>) { this.waits.push(promise); },
    });
  }

  async function emit(event: ReturnType<typeof extendable>) {
    self.dispatchEvent(event);
    await Promise.all(event.waits);
  }

  return {
    puts, fetches, buckets, bodies,
    install() {
      return emit(extendable("install"));
    },
    async activate() {
      await emit(extendable("activate"));
    },
    async fetch(path: string, init?: RequestInit & { navigate?: boolean }) {
      const { navigate, ...requestInit } = init ?? {};
      const request = navigate ? new NavigateRequest(path, requestInit) : new ShellRequest(path, requestInit);
      const event = Object.assign(extendable("fetch"), {
        request, responded: false, response: undefined as Promise<Response> | undefined,
        respondWith(promise: Promise<Response>) {
          this.responded = true;
          this.response = promise;
        },
      });
      await emit(event);
      return { responded: event.responded, response: event.response ? await event.response : undefined };
    },
    cachedPaths() {
      return [...buckets.values()].flatMap(bucket => [...bucket.keys()]).sort();
    },
  };
}

test("the service worker caches only the app shell", async () => {
  const sw = worker();
  await sw.install();
  assert.deepEqual(sw.fetches.slice().sort(), SHELL.map(path => `GET ${path}`).sort());
  assert.deepEqual(sw.cachedPaths(), SHELL.slice().sort());
  assert.deepEqual(sw.puts.slice().sort(), SHELL.slice().sort());

  const shell = sw.cachedPaths();
  const untouched = [
    ["/api/snapshot"],
    ["/api/sync/receipts"],
    ["/auth/login"],
    ["/healthz"],
    ["/mcp"],
    ["/.well-known/oauth-protected-resource"],
    ["/favicon.ico"],
    ["https://other.example/api/snapshot"],
  ] as const;
  for (const [path] of untouched) {
    const result = await sw.fetch(path);
    assert.equal(result.responded, false, path);
  }
  const posted = await sw.fetch("/api/sync/ops", { method: "POST" });
  assert.equal(posted.responded, false);
  assert.deepEqual(sw.cachedPaths(), shell);
  assert.equal(sw.fetches.some(call => call.includes("/api/") || call.includes("/auth/") || call.includes("/mcp")), false);

  sw.bodies.set("/api/snapshot", { body: "{\"revision\":2}", type: "application/json" });
  const asset = await sw.fetch("/assets/app.js");
  assert.equal(asset.responded, true);
  assert.equal(await asset.response?.text(), "console.log('shell')");
  assert.equal(asset.response?.headers.get("Content-Type"), "text/javascript");
  assert.deepEqual(sw.cachedPaths(), shell);

  const navigation = await sw.fetch("/", { navigate: true });
  assert.equal(navigation.responded, true);
  assert.match(await navigation.response?.text() ?? "", new RegExp(BUILD));
  assert.deepEqual(sw.cachedPaths(), shell);

  sw.bodies.set("/person/mom", { body: "{\"revision\":9}", type: "application/json" });
  const staleShell = await sw.fetch("/person/mom", { navigate: true });
  assert.equal(staleShell.responded, true);
  assert.match(await staleShell.response?.text() ?? "", new RegExp(`content="${BUILD}"`));
  assert.equal(sw.puts.length, SHELL.length);
  assert.deepEqual(sw.cachedPaths(), shell);

  await sw.activate();
  assert.deepEqual(sw.cachedPaths(), shell);
});
