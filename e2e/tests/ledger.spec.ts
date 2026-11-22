import { test, expect } from "./fixtures";
import {
  apiHeader, cash, figure, homeHeading, money, openLedger, person, purchase, save, seedPerson,
  sessionCookie, setup, signIn, snapshot, synced,
} from "./ledger";

test("only the configured OIDC subject gets in and all API routes require the custom header", async ({
  app, page, newDevice,
}) => {
  await setup(page, app.url);
  const headers = { ...apiHeader, Cookie: await sessionCookie(page) };
  const identity = await page.request.get(`${app.url}/api/me`, { headers });
  expect(identity.status()).toBe(200);
  expect(await identity.json()).toMatchObject({ subject: app.buyer });

  const endpoints = [
    ["GET", "/api/me"],
    ["GET", "/api/snapshot"],
    ["POST", "/api/sync/receipts"],
    ["POST", "/api/sync/ops"],
    ["POST", "/api/restore"],
    ["POST", "/api/logout"],
  ];
  for (const [method, path] of endpoints) {
    const response = await page.request.fetch(`${app.url}${path}`, { method });
    expect(response.status(), `${method} ${path}`).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  }

  const other = await newDevice();
  await other.context.addCookies([{ name: "mockoidc-other-user", value: "1", url: app.issuer }]);
  await other.page.goto(app.url);
  await signIn(other.page, 403);
  await expect(other.page.getByText("This account cannot access Family Tab.")).toBeVisible();
  const denied = await other.context.request.get(`${app.url}/api/snapshot`, { headers: apiHeader });
  expect(denied.status()).toBe(401);
});

test("Mom's one-time and installment purchases and payment agree on Home and her ledger", async ({ app, page }) => {
  const zone = "Europe/Istanbul";
  const instant = Date.now();
  await page.clock.setFixedTime(instant);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(instant);
  const [year, month, day] = today.split("-").map(Number);
  const thisMonth = year * 12 + month - 1;
  // Move the anchor one day earlier on the 15th so the example stays behind plan.
  const anchor = day === 15 ? 14 : 15;
  const thirdMonth = day > anchor ? thisMonth : thisMonth - 1;
  const on = (monthIndex: number, dayOfMonth: number) =>
    `${Math.floor(monthIndex / 12)}-${String(monthIndex % 12 + 1).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
  const schedule = Array.from({ length: 6 }, (_, i) => on(thirdMonth - 2 + i, anchor));
  const vacuum = 1_200_000;
  const towels = 34_950;
  const payment = 400_000;
  const left = vacuum + towels - payment;
  const installment = vacuum / schedule.length;
  const nextMonth = on(thisMonth + 1, Math.min(day, 28)); // Every scheduled date falls before the 28th.
  const unpaid = schedule.slice(payment / installment);
  const due = unpaid.filter(date => date <= today).length * installment;
  const upcoming = unpaid.filter(date => date > today && date <= nextMonth).length * installment;

  await setup(page, app.url, zone);
  await purchase(page, {
    item: "Robot vacuum", price: "12000", newPerson: "Mom", payday: "15", firstDue: schedule[0],
  });
  await purchase(page, { item: "Kitchen towels", price: "349.50", boughtOn: on(thisMonth - 1, 18) });
  await person(page);
  await cash(page, "4000", { date: on(thirdMonth - 1, 16) });

  await figure(page, "Due by today", due);
  await figure(page, "Left to pay", left);
  await figure(page, "Payments received", payment);
  await figure(page, "Cash returned", 0);
  await expect(page.getByText("Behind plan", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Robot vacuum" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kitchen towels" })).toBeVisible();

  await page.getByRole("link", { name: "Family Tab", exact: true }).click();
  await expect(homeHeading(page)).toHaveText(`Your family owes you ${money(left)}`);
  await figure(page, "Due by today", due);
  await figure(page, "Due in the next month", upcoming);
  await expect(page.getByRole("link", { name: /^Mom .*Behind plan/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Robot vacuum Mom/ })).toContainText(money(installment));
  await synced(page);
  expect((await snapshot(page)).purchases).toHaveLength(2);
});

test("devices on different calendar dates agree on the ledger's midnight boundary", async ({
  app, page, newDevice,
}) => {
  const beforeMidnight = "2025-01-15T09:45:00Z";
  const afterMidnight = "2025-01-15T10:15:00Z";
  const ledgerZone = "Pacific/Kiritimati";
  const west = await newDevice({ timezoneId: "America/Los_Angeles" });
  const east = await newDevice({ timezoneId: ledgerZone });
  await page.clock.setFixedTime(beforeMidnight);
  await setup(page, app.url, ledgerZone);
  await purchase(page, {
    item: "Due at ledger midnight", price: "100", newPerson: "Mom", boughtOn: "2025-01-15", dueDate: "2025-01-16",
  });
  await expect.poll(async () => (await snapshot(page)).purchases.length).toBe(1);

  for (const [device, localDate] of [[west, "2025-01-15"], [east, "2025-01-16"]] as const) {
    await device.page.clock.setFixedTime(beforeMidnight);
    await openLedger(device.page, app.url);
    await figure(device.page, "Due by today", 0);
    await device.page.clock.setFixedTime(afterMidnight);
    await device.page.reload();
    expect(await device.page.evaluate(() => new Intl.DateTimeFormat("sv-SE").format(Date.now()))).toBe(localDate);
    await figure(device.page, "Due by today", 10_000);
  }
});

test("an impossible date stays visible and blocks Save after leaving the field", async ({ app, page }) => {
  await seedPerson(page, app.url);
  await page.getByRole("button", { name: "Record a payment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Record a payment" });
  await dialog.getByLabel("Amount", { exact: true }).fill("25");
  const date = dialog.getByLabel("Date", { exact: true });
  await date.click();
  await date.press("ControlOrMeta+a");
  await date.pressSequentially("31.02.2026");
  await dialog.getByLabel("Note (optional)").click();
  await expect(date).toHaveValue("31.02.2026");
  await expect(date).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("Enter the date as day.month.year.")).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect((await snapshot(page)).payments).toHaveLength(0);
});

test("an invalid purchase date in the collapsed section is revealed when Save is blocked", async ({ app, page }) => {
  await seedPerson(page, app.url);
  await page.getByRole("button", { name: "Add purchase", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add purchase" });
  await dialog.getByLabel("What").fill("Lamp");
  await dialog.getByLabel("Total price").fill("50");
  const details = dialog.locator("details.optional-fields");
  await details.locator("summary").click();
  const date = dialog.getByLabel("Purchase date", { exact: true });
  await date.click();
  await date.press("ControlOrMeta+a");
  await date.pressSequentially("31.02.2026");
  await details.locator("summary").click();
  await expect(date).toBeHidden();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(date).toBeVisible();
  await expect(date).toBeFocused();
  await expect(dialog.getByText("Enter the date as day.month.year.")).toBeVisible();
  await expect(dialog).toBeVisible();
});

test("saving a purchase without a person shows the error by Who on a phone screen", async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, app.url);
  await purchase(page, { item: "Kitchen towels", price: "100", newPerson: "Mom" });
  await purchase(page, { item: "Socks", price: "50", newPerson: "Dad" });
  await page.getByRole("button", { name: /^\+?\s*Add purchase$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Add purchase" });
  await dialog.getByLabel("What").fill("Air fryer");
  await dialog.getByLabel("Total price").fill("4.799,90");
  await dialog.getByRole("button", { name: "In installments", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const error = dialog.getByRole("alert").filter({ hasText: "Choose who this purchase is for." });
  await expect(error).toBeInViewport();
  await expect(dialog.getByRole("group", { name: "Who" }).getByRole("button").first()).toBeFocused();
  expect((await snapshot(page)).purchases).toHaveLength(2);
});

test("a stale edit shows the current version and Reapply in view on a phone screen", async ({ app, page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, app.url);
  await purchase(page, { item: "Vacuum", price: "1200", newPerson: "Mom", firstDue: "2026-12-15" });
  await person(page);
  await page.getByRole("button", { name: "Edit Vacuum", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit purchase" });
  await expect(dialog).toBeVisible();

  const other = await context.newPage();
  await other.setViewportSize({ width: 390, height: 844 });
  await other.goto(page.url());
  await other.getByRole("button", { name: "Edit Vacuum", exact: true }).click();
  const otherDialog = other.getByRole("dialog", { name: "Edit purchase" });
  await otherDialog.getByLabel("What").fill("Robot vacuum");
  await save(otherDialog);

  await dialog.getByLabel("Total price").fill("1300");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Reapply my changes" })).toBeInViewport();
});
