import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHTTPServer, request } from "node:http";
import type { ServerResponse } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import type { BrowserContext, BrowserContextOptions, Page } from "@playwright/test";

const bin = fileURLToPath(new URL("../.bin/", import.meta.url));

type Provider = { issuer: string; clientId: string; clientSecret: string; subject: string };
type App = {
  url: string; buyer: string; issuer: string;
  stall: (path: string, phase?: "headers" | "body") => { started: Promise<void>; resume: () => void };
  respond: (path: string, handler: (response: ServerResponse) => void | Promise<void>) => void;
};
type Device = { context: BrowserContext; page: Page };

function start(binary: string, args: string[], env = process.env) {
  const child = spawn(join(bin, binary), args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let stopped = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.once("error", error => { stopped = error.message; });
  const closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
    stopped ||= `Exited with ${signal ?? code}`;
    resolve();
  }));

  return {
    stdout: () => stdout,
    assertRunning() {
      if (stopped) throw new Error(`${binary}: ${stopped}\n${stderr}`);
    },
    async stop() {
      if (!stopped) child.kill();
      const deadline = setTimeout(() => child.kill("SIGKILL"), 3_000);
      try { await closed; } finally { clearTimeout(deadline); }
    },
  };
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("No loopback port was allocated");
  return address.port;
}

export const test = base.extend<{
  app: App;
  proxyShell: boolean;
  newDevice: (options?: BrowserContextOptions) => Promise<Device>;
}, { provider: Provider }>({
  provider: [async ({}, use) => {
    const provider = start("mockidp", []);
    try {
      await expect.poll(() => {
        provider.assertRunning();
        return provider.stdout();
      }).toContain("\n");
      await use(JSON.parse(provider.stdout()) as Provider);
    } finally {
      await provider.stop();
    }
  }, { scope: "worker" }],

  proxyShell: [false, { option: true }],

  app: async ({ provider, proxyShell }, use) => {
    const port = await availablePort();
    const overrides = new Map<string, (response: ServerResponse) => void | Promise<void>>();
    // Page routing cannot hold the service worker's own fetch or update traffic.
    const proxy = proxyShell ? createHTTPServer(async (incoming, outgoing) => {
      const path = new URL(incoming.url!, "http://localhost").pathname;
      await overrides.get(path)?.(outgoing);
      if (outgoing.writableEnded || outgoing.headersSent) return;
      if (outgoing.destroyed) return;
      const upstream = request({
        hostname: "127.0.0.1", port, path: incoming.url, method: incoming.method, headers: incoming.headers,
      }, response => {
        outgoing.writeHead(response.statusCode!, response.headers);
        response.pipe(outgoing);
      });
      upstream.on("error", () => outgoing.destroy());
      outgoing.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    }) : null;
    if (proxy) await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy?.address();
    const url = `http://localhost:${address && typeof address === "object" ? address.port : port}`;
    const directory = await mkdtemp(join(tmpdir(), "family-tab-e2e-"));
    const server = start("family-tab", [], {
      ...process.env,
      PUBLIC_URL: url,
      LISTEN_ADDR: `127.0.0.1:${port}`,
      COOKIE_INSECURE: "true",
      DB_PATH: join(directory, "ledger.db"),
      BACKUP_DIR: "",
      OIDC_ISSUER: provider.issuer,
      OIDC_CLIENT_ID: provider.clientId,
      OIDC_CLIENT_SECRET: provider.clientSecret,
      BUYER_SUBJECT: provider.subject,
    });
    try {
      await expect.poll(async () => {
        server.assertRunning();
        const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
        await response?.body?.cancel();
        return response?.status;
      }).toBe(200);
      await use({
        url, buyer: provider.subject, issuer: provider.issuer,
        stall(path, phase = "headers") {
          if (!proxy) throw new Error("Stalling requests requires the loopback proxy.");
          let resume!: () => void;
          const held = new Promise<void>(resolve => { resume = resolve; });
          const started = new Promise<void>(resolve => overrides.set(path, async response => {
            if (phase === "body") {
              response.writeHead(200, { "Content-Type": "text/html" });
              response.flushHeaders();
            }
            resolve();
            await held;
            if (phase === "body") response.end("<!doctype html><title>Stalled shell</title>");
          }));
          return { started, resume: () => { overrides.delete(path); resume(); } };
        },
        respond(path, handler) {
          if (!proxy) throw new Error("Overriding responses requires the loopback proxy.");
          overrides.set(path, handler);
        },
      });
    } finally {
      if (proxy) await new Promise<void>(resolve => {
        proxy.close(() => resolve());
        proxy.closeAllConnections();
      });
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },

  newDevice: async ({ browser, contextOptions }, use) => {
    const contexts: BrowserContext[] = [];
    try {
      await use(async options => {
        const context = await browser.newContext({ ...contextOptions, ...options });
        contexts.push(context);
        return { context, page: await context.newPage() };
      });
    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  },
});

export { expect };
