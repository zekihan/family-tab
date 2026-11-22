import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import {
  apiHeader, cash, figure, goOffline, homeHeading, money, openLedger, person, purchase, seedPerson,
  sessionCookie, settings, signIn, snapshot, synced, syncStatus,
} from "./ledger";

test.describe("online with an unavailable shell", () => {
  test.use({ proxyShell: true });

  for (const [path, phase, name] of [
    ["/", "headers", "the navigation headers stall"],
    ["/sw.js", "headers", "the service worker script stalls"],
    ["/", "body", "the navigation body stalls after 200 headers"],
  ] as const) {
    test(`the installed ledger opens when ${name}`, async ({ app, page }) => {
      await seedPerson(page, app.url);
      await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      const { started, resume } = app.stall(path, phase);
      try {
        const deadline = performance.now() + 8_000;
        await page.reload({ waitUntil: "commit", timeout: 8_000 });
        await expect(page.getByRole("heading", { name: "Mom", exact: true }))
          .toBeVisible({ timeout: Math.max(1, deadline - performance.now()) });
        await started;
        expect(await page.evaluate(() => navigator.onLine)).toBe(true);
        await figure(page, "Left to pay", 10_000);
      } finally {
        resume();
      }
    });
  }

  for (const [status, name] of [[502, "a 502 response"], [200, "an HTML shell from another build"]] as const) {
    test(`the installed ledger opens despite ${name}`, async ({ app, page }) => {
      await seedPerson(page, app.url);
      await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      app.respond("/", response => {
        response.writeHead(status, { "Content-Type": "text/html" });
        response.end('<!doctype html><meta name="family-tab-build" content="different-build"><title>Other shell</title>');
      });
      await page.reload();
      await expect(page.getByRole("heading", { name: "Mom", exact: true })).toBeVisible();
      await figure(page, "Left to pay", 10_000);
    });
  }

  test("a controlled navigation can still redirect to sign-in", async ({ app, page }) => {
    await seedPerson(page, app.url);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    let redirected = false;
    app.respond("/", response => {
      if (redirected) return;
      redirected = true;
      response.writeHead(302, { Location: "/auth/login", "Cache-Control": "no-store" });
      response.end();
    });
    const login = page.waitForResponse(response => new URL(response.url()).pathname === "/auth/login");
    await page.reload();
    expect((await login).status()).toBe(303);
    await expect(page.getByRole("heading", { name: "Mom", exact: true })).toBeVisible();
  });

  test("navigation and service worker discovery share one startup window", async ({ app, page }) => {
    await seedPerson(page, app.url);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const navigation = app.stall("/");
    const script = app.stall("/sw.js");
    try {
      const deadline = performance.now() + 7_000;
      await page.reload({ waitUntil: "commit", timeout: 7_000 });
      await expect(page.getByRole("heading", { name: "Mom", exact: true }))
        .toBeVisible({ timeout: Math.max(1, deadline - performance.now()) });
      await Promise.all([navigation.started, script.started]);
      await figure(page, "Left to pay", 10_000);
    } finally {
      navigation.resume();
      script.resume();
    }
  });

  test("a stalled shell install leaves a draft open and activates the update on the next startup", async ({ app, page }) => {
    await seedPerson(page, app.url);
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const build = page.locator('meta[name="family-tab-build"]');
    const originalBuild = (await build.getAttribute("content"))!;
    const nextBuild = "next-e2e-build";
    const [script, html] = await Promise.all(["sw.js", "index.html"].map(path =>
      readFile(new URL(`../../web/dist/${path}`, import.meta.url), "utf8"),
    ));
    const precacheStarted = Promise.withResolvers<void>();
    const releasePrecache = Promise.withResolvers<void>();
    app.respond("/sw.js", response => {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(script.replace(originalBuild, nextBuild));
    });
    app.respond("/index.html", async response => {
      precacheStarted.resolve();
      await releasePrecache.promise;
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html.replace(originalBuild, nextBuild));
    });
    try {
      await page.reload({ waitUntil: "commit" });
      await precacheStarted.promise;
      await expect(page.getByRole("heading", { name: "Mom", exact: true })).toBeVisible();
      await expect(build).toHaveAttribute("content", originalBuild);
      await page.getByRole("button", { name: "Record a payment" }).click();
      const note = page.getByRole("dialog").getByLabel("Note (optional)");
      await note.fill("Unfinished payment");

      releasePrecache.resolve();
      await expect.poll(() => page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistration())?.waiting?.state,
      )).toBe("installed");
      await expect(note).toHaveValue("Unfinished payment");

      app.respond("/", response => {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(html.replace(originalBuild, nextBuild).replace("<html", '<html data-network-shell="true"'));
      });
      await page.reload({ waitUntil: "commit" });
      await expect(build).toHaveAttribute("content", nextBuild);
      await expect(page.locator("html")).toHaveAttribute("data-network-shell", "true");
      await expect(page.getByRole("heading", { name: "Mom", exact: true })).toBeVisible();
      await figure(page, "Left to pay", 10_000);
    } finally {
      releasePrecache.resolve();
    }
  });
});

test("the cached ledger reloads offline and saved changes reach a fresh device after reconnect", async ({
  app, page, newDevice,
}) => {
  await seedPerson(page, app.url);
  await goOffline(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Mom", exact: true })).toBeVisible();
  await figure(page, "Left to pay", 10_000);
  await purchase(page, { item: "Offline kettle", price: "50" });
  await cash(page, "25", { note: "Offline payment" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Offline kettle" })).toBeVisible();
  await expect(page.getByText("Offline payment", { exact: true })).toBeVisible();
  await figure(page, "Left to pay", 12_500);
  await expect(syncStatus(page)).toContainText("2 changes pending");
  expect((await snapshot(page)).payments).toHaveLength(0);

  await page.context().setOffline(false);
  await synced(page);
  const other = await newDevice();
  await openLedger(other.page, app.url);
  await person(other.page);
  await expect(other.page.getByRole("heading", { name: "Offline kettle" })).toBeVisible();
  await expect(other.page.getByText("Offline payment", { exact: true })).toBeVisible();
  await figure(other.page, "Left to pay", 12_500);
});

test("payment deletion can be undone after reload and syncs only when Undo expires", async ({ app, page }) => {
  await page.clock.install({ time: Date.now() });
  await seedPerson(page, app.url);
  await cash(page, "25");
  await synced(page);
  const original = (await snapshot(page)).payments;
  expect(original).toHaveLength(1);

  const remove = page.getByRole("button", { name: `Delete payment of ${money(2_500)}` });
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await remove.click();
  await expect(undo).toBeVisible();
  await page.clock.fastForward(4_000);
  await page.reload();
  await expect(undo).toBeVisible();
  await figure(page, "Payments received", 0);
  expect((await snapshot(page)).payments).toEqual(original);
  await undo.click();
  await figure(page, "Payments received", 2_500);
  await synced(page);
  expect((await snapshot(page)).payments).toEqual(original);

  await remove.click();
  await expect(undo).toBeVisible();
  await page.clock.fastForward(4_000);
  await page.reload();
  await expect(undo).toBeVisible();
  expect((await snapshot(page)).payments).toEqual(original);
  await page.clock.fastForward(4_000);
  await expect(undo).toBeHidden();
  await synced(page);
  expect((await snapshot(page)).payments).toEqual([]);
});

test("an expired server session holds an offline payment until the buyer signs in again", async ({
  app, page, request,
}) => {
  await seedPerson(page, app.url);
  const headers = { ...apiHeader, Cookie: await sessionCookie(page) };
  await goOffline(page);
  expect((await request.post(`${app.url}/api/logout`, { headers })).status()).toBe(204);
  expect((await request.get(`${app.url}/api/me`, { headers })).status()).toBe(401);
  await cash(page, "25", { note: "Saved with expired session" });
  await page.context().setOffline(false);
  await expect(syncStatus(page)).toContainText("Sign in to resume sync");
  await expect(syncStatus(page)).toContainText("1 change pending");
  await figure(page, "Payments received", 2_500);

  await signIn(page);
  await expect(homeHeading(page)).toBeVisible();
  await synced(page);
  await person(page);
  await expect(page.getByText("Saved with expired session", { exact: true })).toBeVisible();
  expect((await snapshot(page)).payments.map(payment => payment.amountMinor)).toEqual([2_500]);
});

test("offline sign-out purges the local ledger and revokes the old session on reconnect", async ({
  app, page, request,
}) => {
  await seedPerson(page, app.url);
  const headers = { ...apiHeader, Cookie: await sessionCookie(page) };
  await goOffline(page);
  await cash(page, "25", { note: "Discard this payment" });
  await settings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out of this device?" });
  await expect(dialog).toContainText("1 pending change");
  await dialog.getByRole("button", { name: "Discard changes and sign out" }).click();
  await expect(page.getByText("Connect to finish signing out.")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Connect to finish signing out.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeHidden();
  await expect(page.getByText("Discard this payment")).toBeHidden();
  const counts = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("family-tab");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = ["snapshot", "queue", "drafts"];
      const transaction = database.transaction(stores);
      return await Promise.all(stores.map(name => new Promise<number>((resolve, reject) => {
        const request = transaction.objectStore(name).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })));
    } finally {
      database.close();
    }
  });
  expect(counts).toEqual([0, 0, 0]);
  expect((await request.get(`${app.url}/api/me`, { headers })).status()).toBe(200);

  await page.context().setOffline(false);
  await expect(page.getByRole("link", { name: "Sign in with SSO" })).toBeVisible();
  expect((await request.get(`${app.url}/api/me`, { headers })).status()).toBe(401);

  await signIn(page);
  await page.getByRole("link", { name: "Family Tab", exact: true }).click();
  await person(page);
  await figure(page, "Payments received", 0);
  expect((await snapshot(page)).payments).toEqual([]);
});
