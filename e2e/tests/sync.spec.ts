import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  cash, figure, goOffline, homeHeading, money, openLedger, person, purchase, review, save, seedPerson,
  settings, setup, signIn, snapshot, synced, syncStatus,
} from "./ledger";

for (const plan of ["once", "installments"] as const) {
  test(`a draft keeps its ${plan === "once" ? "selected payday date" : "default installment date and anchor"} when another tab clears payday`, async ({
    app, page, context,
  }) => {
    const now = "2025-02-15T12:00:00Z";
    await page.clock.setFixedTime(now);
    await setup(page, app.url);
    await purchase(page, { item: "Kitchen towels", price: "100", newPerson: "Mom", payday: "30" });
    await person(page);
    await synced(page);

    const other = await context.newPage();
    await other.clock.setFixedTime(now);
    await other.goto(page.url());
    await other.getByRole("button", { name: "Edit person" }).click();
    const editor = other.getByRole("dialog", { name: "Edit person" });

    await page.getByRole("button", { name: "Add purchase", exact: true }).click();
    const draft = page.getByRole("dialog", { name: "Add purchase" });
    await draft.getByLabel("What").fill("Vacuum");
    await draft.getByLabel("Total price").fill("500");
    if (plan === "once") {
      await draft.getByRole("button", { name: "Their payday" }).click();
      await expect(draft.getByText("28 Feb 2025", { exact: true })).toBeVisible();
    } else {
      await draft.getByRole("button", { name: "In installments" }).click();
      await expect(draft.getByLabel("First due date", { exact: true })).toHaveValue("28.02.2025");
    }

    await editor.getByLabel("Name", { exact: true }).fill("Mom updated");
    await editor.getByLabel("Payday (optional)").fill("");
    await save(editor);
    await synced(other);
    await expect(draft.getByRole("button", { name: "Mom updated" })).toBeVisible();

    if (plan === "once") {
      await expect(draft.getByRole("button", { name: "Their payday" })).toHaveCount(0);
      await expect(draft.getByRole("button", { name: "Custom date", pressed: true })).toBeVisible();
      await expect(draft.getByLabel("Custom due date", { exact: true })).toHaveValue("28.02.2025");
    } else {
      await expect(draft.getByLabel("First due date", { exact: true })).toHaveValue("28.02.2025");
      await expect(draft.getByText(/30 Jul 2025/)).toBeVisible();
    }
    await save(draft);
    await synced(page);
    const saved = (await snapshot(page)).purchases.find(row => row.item === "Vacuum");
    expect(saved).toMatchObject(plan === "once"
      ? { dueDate: "2025-02-28" } : { firstDue: "2025-02-28", dueDay: 30 });
  });
}

test("selecting installments uses the payday synced while the draft was on all at once", async ({ app, page, context }) => {
  const now = "2025-02-15T12:00:00Z";
  await page.clock.setFixedTime(now);
  await setup(page, app.url);
  await purchase(page, { item: "Towels", price: "100", newPerson: "Mom", payday: "30" });
  await person(page);
  await synced(page);

  const other = await context.newPage();
  await other.clock.setFixedTime(now);
  await other.goto(page.url());
  await other.getByRole("button", { name: "Edit person" }).click();
  const editor = other.getByRole("dialog", { name: "Edit person" });

  await page.getByRole("button", { name: "Add purchase", exact: true }).click();
  const draft = page.getByRole("dialog", { name: "Add purchase" });
  await draft.getByLabel("What").fill("Vacuum");
  await draft.getByLabel("Total price").fill("600");
  await expect(draft.getByRole("button", { name: "All at once", pressed: true })).toBeVisible();

  await editor.getByLabel("Name", { exact: true }).fill("Mom updated");
  await editor.getByLabel("Payday (optional)").fill("18");
  await save(editor);
  await synced(other);
  await expect(draft.getByRole("button", { name: "Mom updated" })).toBeVisible();

  await draft.getByRole("button", { name: "In installments" }).click();
  await expect(draft.getByLabel("First due date", { exact: true })).toHaveValue("18.02.2025");
  await expect(draft.getByText(/18 Jul 2025/)).toBeVisible();
  await save(draft);
  await synced(page);
  expect((await snapshot(page)).purchases.find(row => row.item === "Vacuum")).toMatchObject({
    firstDue: "2025-02-18", dueDay: 18,
  });
});

test("setup and settings save time zones with IANA casing", async ({ app, page }) => {
  await setup(page, app.url, "europe/istanbul");
  expect((await snapshot(page)).settings?.timeZone).toBe("Europe/Istanbul");
  await settings(page);
  await page.getByRole("button", { name: "Change time zone" }).click();
  const dialog = page.getByRole("dialog", { name: "Ledger time zone" });
  await dialog.getByLabel("Ledger time zone").fill("america/new_york");
  await save(dialog);
  await synced(page);
  expect((await snapshot(page)).settings?.timeZone).toBe("America/New_York");
});

test("rejected setup can be edited and discarded from the setup screen", async ({ app, page }) => {
  await page.goto(app.url);
  await signIn(page);
  const attempts: { id: string; timeZone: string }[] = [];
  await page.route("**/api/sync/ops", async route => {
    const body = route.request().postDataJSON();
    const { op } = body.items[0];
    attempts.push({ id: op.id, timeZone: op.record.timeZone });
    if (attempts.length <= 2) {
      op.record.timeZone = "Bogus/City";
      await route.continue({ postData: JSON.stringify(body) });
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("Ledger time zone").fill("UTC");
  await page.getByRole("button", { name: "Confirm time zone" }).click();
  const item = page.getByRole("article").filter({ hasText: "unknown time zone Bogus/City" });
  await expect(item).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm time zone" })).toBeHidden();

  await item.getByRole("button", { name: "Edit and resubmit" }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByLabel("Ledger time zone")).toHaveValue("UTC");
  await editor.getByLabel("Ledger time zone").fill("Europe/Istanbul");
  await editor.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(item).toContainText("Europe/Istanbul");
  expect(attempts.map(attempt => attempt.timeZone)).toEqual(["UTC", "Europe/Istanbul"]);
  expect(attempts[0].id).not.toBe(attempts[1].id);
  await expect(syncStatus(page)).toContainText("1 change pending");
  await item.getByRole("button", { name: "Discard" }).click();

  await page.getByLabel("Ledger time zone").fill("Europe/Istanbul");
  await page.getByRole("button", { name: "Confirm time zone" }).click();
  await synced(page);
  expect((await snapshot(page)).settings?.timeZone).toBe("Europe/Istanbul");
});

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

test("refund conflict resubmission keeps the original purchase read-only", async ({ app, page, newDevice }) => {
  await seedPerson(page, app.url);
  await purchase(page, { item: "Shoes", price: "60" });
  const towels = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Kitchen towels" }) });
  await towels.getByRole("button", { name: "Record shop refund" }).click();
  const create = page.getByRole("dialog", { name: "Record shop refund" });
  await create.getByLabel("Amount", { exact: true }).fill("10");
  await save(create);
  await synced(page);
  const original = (await snapshot(page)).refunds[0];
  const other = await newDevice();
  await openLedger(other.page, app.url);
  await person(other.page);

  async function editRefund(device: Page, amount: string) {
    await device.getByRole("button", { name: "Edit shop refund for Kitchen towels" }).click();
    const editor = device.getByRole("dialog", { name: "Edit shop refund" });
    await editor.getByLabel("Amount", { exact: true }).fill(amount);
    await save(editor);
  }

  await goOffline(other.page);
  await editRefund(other.page, "15");
  await editRefund(page, "20");
  await synced(page);
  await other.context.setOffline(false);
  const item = await review(other.page, "Edit shop refund");
  await item.getByRole("button", { name: "Edit and resubmit" }).click();
  const editor = other.page.getByRole("dialog", { name: "Resubmit shop refund" });
  const purchaseField = editor.getByRole("combobox", { name: "Purchase", exact: true });
  await expect(purchaseField).toHaveValue(original.purchaseId);
  await expect(purchaseField).toBeDisabled();
  await editor.getByRole("button", { name: "Resubmit", exact: true }).click();
  await synced(other.page);
  expect((await snapshot(other.page)).refunds).toMatchObject([
    { id: original.id, purchaseId: original.purchaseId, amountMinor: 1_500 },
  ]);
});

test("reapplying in a review editor resubmits against the displayed version", async ({ app, page, newDevice }) => {
  await seedPerson(page, app.url);
  await cash(page, "25");
  await synced(page);
  const other = await newDevice();
  await openLedger(other.page, app.url);
  await person(other.page);

  await goOffline(other.page);
  await cash(other.page, "45", { fromMinor: 2_500 });
  await cash(page, "30", { fromMinor: 2_500 });
  await synced(page);
  await other.context.setOffline(false);
  const item = await review(other.page, "Edit payment");
  await item.getByRole("button", { name: "Edit and resubmit" }).click();
  const editor = other.page.getByRole("dialog", { name: "Resubmit payment" });
  await editor.getByLabel("Note (optional)").fill("Keep this draft");
  const submit = editor.getByRole("button", { name: "Resubmit", exact: true });

  await cash(page, "35", { fromMinor: 3_000, date: "2025-01-15" });
  await synced(page);
  const latest = (await snapshot(page)).payments[0];
  await other.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(item).toContainText("35 TL");
  await submit.click();
  const notice = editor.getByRole("alert");
  await expect(notice).toContainText("35 TL");
  await notice.getByRole("button", { name: "Reapply my changes" }).click();
  await expect(editor.getByLabel("Note (optional)")).toHaveValue("Keep this draft");
  const [resubmit] = await Promise.all([
    other.page.waitForRequest(request => request.url().endsWith("/api/sync/ops")),
    submit.click().then(() => expect(editor).toBeHidden()),
  ]);
  expect(resubmit.postDataJSON().items[0].op.baseVersion).toBe(latest.version);
  await synced(other.page);
  expect((await snapshot(other.page)).payments).toMatchObject([
    { id: latest.id, amountMinor: 4_500, note: "Keep this draft", paidOn: latest.paidOn },
  ]);
});

test("a review editor recreates a remotely deleted payment with its open draft", async ({ app, page, newDevice }) => {
  await page.clock.install({ time: Date.now() });
  await seedPerson(page, app.url);
  await cash(page, "25");
  await synced(page);
  const other = await newDevice();
  await openLedger(other.page, app.url);
  await person(other.page);

  await goOffline(other.page);
  await cash(other.page, "45", { fromMinor: 2_500 });
  await cash(page, "30", { fromMinor: 2_500 });
  await synced(page);
  const [original] = (await snapshot(page)).payments;
  await other.context.setOffline(false);
  const item = await review(other.page, "Edit payment");
  await item.getByRole("button", { name: "Edit and resubmit" }).click();
  const editor = other.page.getByRole("dialog", { name: "Resubmit payment" });
  await editor.getByLabel("Note (optional)").fill("Keep this draft");

  await page.getByRole("button", { name: `Delete payment of ${money(3_000)}` }).click();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await page.clock.fastForward(8_000);
  await synced(page);
  expect((await snapshot(page)).payments).toEqual([]);
  await other.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(item.getByText("No record", { exact: true })).toBeVisible();

  await editor.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("This record was removed while you were editing.");
  await expect(editor.getByLabel("Note (optional)")).toHaveValue("Keep this draft");
  const recreate = editor.getByRole("button", { name: "Recreate with my changes" });
  await expect(recreate).toBeEnabled();
  await recreate.click();
  await expect(editor).toBeHidden();
  await synced(other.page);
  expect((await snapshot(other.page)).payments).toMatchObject([
    { id: original.id, amountMinor: 4_500, note: "Keep this draft" },
  ]);
});

test("a held purchase can be resubmitted for a new person", async ({ app, page, newDevice }) => {
  await seedPerson(page, app.url);
  const [original] = (await snapshot(page)).purchases;
  const other = await newDevice();
  await openLedger(other.page, app.url);
  await person(other.page);

  async function editPurchase(device: Page, item: string) {
    await device.getByRole("button", { name: "Edit Kitchen towels", exact: true }).click();
    const editor = device.getByRole("dialog", { name: "Edit purchase" });
    await editor.getByLabel("What", { exact: true }).fill(item);
    await save(editor);
  }
  await goOffline(other.page);
  await editPurchase(other.page, "Tea towels");
  await editPurchase(page, "Bath towels");
  await synced(page);
  await other.context.setOffline(false);
  const item = await review(other.page, "Edit purchase");
  await item.getByRole("button", { name: "Edit and resubmit" }).click();
  const editor = other.page.getByRole("dialog", { name: "Resubmit purchase" });
  await editor.getByRole("button", { name: "+ New person", exact: true }).click();
  await editor.getByLabel("Name", { exact: true }).fill("Dad");
  await editor.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(editor).toBeHidden();
  await synced(other.page);
  const committed = await snapshot(other.page);
  const dad = committed.people.find(person => person.name === "Dad");
  expect(dad).toBeDefined();
  expect(committed.purchases).toMatchObject([{ id: original.id, item: "Tea towels", personId: dad!.id }]);
});

test("restore review prefills an offline payment edit when the backup lacks that payment", async ({
  app, page, newDevice,
}) => {
  await seedPerson(page, app.url);
  await settings(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const backup = await (await download).path();
  await page.getByRole("link", { name: "Family Tab", exact: true }).click();
  await person(page);
  await cash(page, "25", { date: "2025-01-15", note: "Bank transfer" });
  await synced(page);
  const original = (await snapshot(page)).payments[0];
  const other = await newDevice();
  await openLedger(other.page, app.url);
  await person(other.page);
  await goOffline(other.page);
  await cash(other.page, "45", { fromMinor: 2_500 });

  await settings(page);
  await page.getByLabel("Choose backup file").setInputFiles(backup);
  const confirmation = page.getByRole("dialog", { name: "Restore backup" });
  await confirmation.getByRole("button", { name: "Replace ledger" }).click();
  await expect(confirmation).toBeHidden();
  expect((await snapshot(page)).payments).toEqual([]);
  await other.context.setOffline(false);
  const item = await review(other.page, "Edit payment");
  await item.getByRole("button", { name: "Edit and resubmit" }).click();
  const editor = other.page.getByRole("dialog", { name: "Resubmit payment" });
  await expect(editor.getByLabel("Who")).toHaveValue(original.personId);
  await expect(editor.getByLabel("Note (optional)")).toHaveValue(original.note!);
  await expect(editor.getByLabel("Date", { exact: true })).toHaveValue("15.01.2025");
  await editor.getByRole("button", { name: "Resubmit", exact: true }).click();
  await synced(other.page);
  const { version, ...fields } = original;
  const [restored] = (await snapshot(other.page)).payments;
  expect(restored).toMatchObject({ ...fields, amountMinor: 4_500 });
  expect(restored.version).not.toBe(version);
});

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

test("a payout edited in conflict review can be confirmed above credit", async ({ app, page, newDevice }) => {
  await seedPerson(page, app.url);
  await cash(page, "500");
  await cash(page, "100", { payout: true });
  await synced(page);
  const other = await newDevice();
  await openLedger(other.page, app.url);
  await person(other.page);
  await goOffline(other.page);

  const editPayout = async (device: Page) => {
    await device.getByRole("button", { name: "Edit cash return of 100 TL", exact: true }).click();
    return device.getByRole("dialog", { name: "Edit cash returned" });
  };
  const local = await editPayout(other.page);
  await local.getByLabel("Amount", { exact: true }).fill("250");
  await save(local);
  const remote = await editPayout(page);
  await remote.getByLabel("Note (optional)").fill("Server note");
  await save(remote);
  await purchase(page, { item: "Shoes", price: "300" });
  await synced(page);

  await other.context.setOffline(false);
  const item = await review(other.page, "Edit cash return");
  await expect(item.getByRole("button", { name: "Keep mine", exact: true })).toBeVisible();
  await item.getByRole("button", { name: "Edit and resubmit" }).click();
  const editor = other.page.getByRole("dialog", { name: "Resubmit cash return" });
  await editor.getByLabel("Amount", { exact: true }).fill("230");
  await editor.getByLabel("Note (optional)").fill("My updated note");
  await editor.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(item).toContainText("230 TL");
  await expect(item).toContainText("My updated note");
  await item.getByRole("button", { name: "Confirm cash already returned", exact: true }).click();
  const dialog = other.page.getByRole("dialog", { name: "Confirm cash already returned" });
  await expect(dialog).toContainText("230 TL");
  await expect(dialog).toContainText("My updated note");
  await dialog.getByRole("button", { name: "Confirm cash already returned", exact: true }).click();
  await synced(other.page);
  expect((await snapshot(other.page)).payouts).toMatchObject([{ amountMinor: 23_000, note: "My updated note" }]);
});
