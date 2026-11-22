import { test, expect } from "./fixtures";
import {
  apiHeader, cash, figure, goOffline, homeHeading, money, openLedger, person, purchase, seedPerson,
  sessionCookie, settings, signIn, snapshot, synced, syncStatus,
} from "./ledger";

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
