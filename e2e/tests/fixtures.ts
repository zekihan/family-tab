import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import type { BrowserContext, BrowserContextOptions, Page } from "@playwright/test";

const bin = fileURLToPath(new URL("../.bin/", import.meta.url));
const buyer = "family-tab-buyer";

type Provider = { Issuer: string; ClientID: string; ClientSecret: string };
type App = { url: string; buyer: string; issuer: string };
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
  newDevice: (options?: BrowserContextOptions) => Promise<Device>;
}, { provider: Provider }>({
  provider: [async ({}, use) => {
    const provider = start("mockidp", ["-subject", buyer, "-port", process.env.E2E_OIDC_PORT ?? "18081"]);
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

  app: async ({ provider }, use) => {
    const port = await availablePort();
    const url = `http://localhost:${port}`;
    const directory = await mkdtemp(join(tmpdir(), "family-tab-e2e-"));
    const server = start("family-tab", [], {
      ...process.env,
      PUBLIC_URL: url,
      LISTEN_ADDR: `127.0.0.1:${port}`,
      COOKIE_INSECURE: "true",
      DB_PATH: join(directory, "ledger.db"),
      BACKUP_DIR: "",
      OIDC_ISSUER: provider.Issuer,
      OIDC_CLIENT_ID: provider.ClientID,
      OIDC_CLIENT_SECRET: provider.ClientSecret,
      BUYER_SUBJECT: buyer,
    });
    try {
      await expect.poll(async () => {
        server.assertRunning();
        const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
        await response?.body?.cancel();
        return response?.status;
      }).toBe(200);
      await use({ url, buyer, issuer: provider.Issuer });
    } finally {
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
