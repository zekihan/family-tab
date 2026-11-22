import { test, expect } from "./fixtures";
import {
  cash, figure, goOffline, homeHeading, openLedger, person, purchase, review, seedPerson,
  settings, snapshot, synced, syncStatus,
} from "./ledger";

test("a payment committed before a network failure is recorded exactly once", async ({ app, page }) => {
  await seedPerson(page, app.url);
  let lostResponse = false;
  await page.route("**/api/sync/ops", async route => {
    if (lostResponse) {
      await route.continue();
      return;
    }
    lostResponse = true;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ status: "applied" }] });
    await route.abort("failed");
  });

  await cash(page, "25", { note: "Network retry" });
  await expect(syncStatus(page)).toContainText("Could not reach the Family Tab server.");
  expect((await snapshot(page)).payments.map(payment => payment.amountMinor)).toEqual([2_500]);

  const receipts = page.waitForResponse(response => response.url() === `${app.url}/api/sync/receipts`);
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  expect(await (await receipts).json()).toMatchObject({ receipts: [{ status: "applied" }] });
  await synced(page);
  await figure(page, "Payments received", 2_500);
  await expect(page.getByText("Network retry", { exact: true })).toHaveCount(1);
  expect((await snapshot(page)).payments.map(payment => payment.amountMinor)).toEqual([2_500]);
});

test("closing a tab that holds the sync lock lets another tab sync queued changes", async ({
  app, page, context,
}) => {
  await seedPerson(page, app.url);
  const holder = await context.newPage();
  // Load a same-origin document without starting a second app sync cycle.
  await holder.goto(`${app.url}/healthz`);
  await holder.evaluate(() => new Promise<void>(acquired => {
    void navigator.locks.request("family-tab-sync", async () => {
      acquired();
      await new Promise<void>(() => {});
    });
  }));

  await cash(page, "25");
  await expect(syncStatus(page)).toContainText("1 change pending");
  expect((await snapshot(page)).payments).toEqual([]);
  await holder.close();

  await synced(page);
  expect((await snapshot(page)).payments.map(payment => payment.amountMinor)).toEqual([2_500]);
});

test("a restore blocks Save in another tab and refreshes both tabs", async ({ app, page, context }) => {
  await seedPerson(page, app.url);
  await settings(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const backup = await (await download).path();

  await page.getByRole("link", { name: "Family Tab", exact: true }).click();
  await person(page);
  await cash(page, "25");
  await synced(page);
  const before = await snapshot(page);

  const other = await context.newPage();
  await other.goto(app.url);
  await person(other);
  await other.getByRole("button", { name: "Record a payment", exact: true }).click();
  const editor = other.getByRole("dialog", { name: "Record a payment" });
  await editor.getByLabel("Amount", { exact: true }).fill("50");
  const save = editor.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();

  await settings(page);
  await page.getByLabel("Choose backup file").setInputFiles(backup);
  const confirmation = page.getByRole("dialog", { name: "Restore backup" });
  await expect(confirmation.getByRole("row", { name: "Payments 1 0" })).toBeVisible();

  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/restore", async route => {
    await hold;
    await route.continue();
  });
  try {
    const request = page.waitForRequest(request => request.url() === `${app.url}/api/restore`);
    await confirmation.getByRole("button", { name: "Replace ledger" }).click();
    await request;
    await expect(editor.getByRole("status")).toContainText("Restore in progress.");
    await expect(save).toBeDisabled();
    expect((await snapshot(other)).payments).toEqual(before.payments);
  } finally {
    release();
  }
  await expect(confirmation).toBeHidden();
  await expect(editor.getByRole("status")).toBeHidden();
  await editor.getByRole("button", { name: "Close dialog" }).click();
  await figure(other, "Payments received", 0);

  await page.getByRole("link", { name: "Family Tab", exact: true }).click();
  await person(page);
  await figure(page, "Payments received", 0);
  const restored = await snapshot(page);
  expect(restored.generation).not.toBe(before.generation);
  expect(restored.payments).toEqual([]);
});

for (const choice of ["Keep mine", "Keep server"]) {
  test(`offline payment conflicts can be resolved with ${choice}`, async ({ app, page, newDevice }) => {
    await seedPerson(page, app.url);
    await cash(page, "25");
    await synced(page);
    const other = await newDevice();
    await openLedger(other.page, app.url);
    await person(other.page);

    await goOffline(page);
    await goOffline(other.page);
    await cash(page, "30", { fromMinor: 2_500 });
    await cash(other.page, "45", { fromMinor: 2_500 });
    await figure(other.page, "Payments received", 4_500);

    await page.context().setOffline(false);
    await synced(page);
    expect((await snapshot(page)).payments.map(payment => payment.amountMinor)).toEqual([3_000]);
    await other.context.setOffline(false);
    await expect(syncStatus(other.page)).toContainText("Some changes need review.");
    await figure(other.page, "Payments received", 3_000);
    const item = await review(other.page, "Edit payment");
    await expect(item).toContainText("30 TL");
    await expect(item).toContainText("45 TL");
    await item.getByRole("button", { name: choice, exact: true }).click();
    await expect(other.page.getByText("No changes need review.")).toBeVisible();
    await synced(other.page);

    const expected = choice === "Keep mine" ? 4_500 : 3_000;
    expect((await snapshot(other.page)).payments.map(payment => payment.amountMinor)).toEqual([expected]);
    await other.page.getByRole("link", { name: "Family Tab", exact: true }).click();
    await expect(homeHeading(other.page)).toBeVisible();
    await person(other.page);
    await figure(other.page, "Payments received", expected);
  });
}

test("a cash payout above the remaining credit is held and can be confirmed as already returned", async ({
  app, page, newDevice,
}) => {
  await seedPerson(page, app.url);
  await cash(page, "200");
  await synced(page);
  const other = await newDevice();
  await openLedger(other.page, app.url);
  await person(other.page);
  await figure(other.page, "Credit", 10_000);

  await goOffline(other.page);
  await cash(other.page, "80", { payout: true });
  await figure(other.page, "Cash returned", 8_000);
  await purchase(page, { item: "Shoes", price: "60" });
  await synced(page);
  await figure(page, "Credit", 4_000);

  await other.context.setOffline(false);
  await expect(syncStatus(other.page)).toContainText("Some changes need review.");
  await figure(other.page, "Cash returned", 0);
  expect((await snapshot(page)).payouts).toEqual([]);
  const item = await review(other.page, "Add cash return");
  await item.getByRole("button", { name: "Confirm cash already returned", exact: true }).click();
  const dialog = other.page.getByRole("dialog", { name: "Confirm cash already returned" });
  await dialog.getByRole("button", { name: "Confirm cash already returned", exact: true }).click();
  await expect(other.page.getByText("No changes need review.")).toBeVisible();
  await synced(other.page);
  expect((await snapshot(other.page)).payouts.map(payout => payout.amountMinor)).toEqual([8_000]);
  await other.page.getByRole("link", { name: "Family Tab", exact: true }).click();
  await person(other.page);
  await figure(other.page, "Cash returned", 8_000);
  await figure(other.page, "Left to pay", 4_000);
});
