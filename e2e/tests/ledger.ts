import type { Locator, Page } from "@playwright/test";
import type { Snapshot } from "../../web/src/types";
import { expect } from "./fixtures";

export const apiHeader = { "X-Family-Tab": "1" };
export const money = (minor: number) =>
  new Intl.NumberFormat("tr-TR", { minimumFractionDigits: minor % 100 ? 2 : 0 })
    .format(minor / 100) + " TL";

export const homeHeading = (page: Page) => page.getByRole("heading", { name: /^Your family owes you/ });
export const syncStatus = (page: Page) => page.getByRole("complementary", { name: "Sync status" });
const button = (scope: Page | Locator, name: string) => scope.getByRole("button", { name, exact: true });

export async function signIn(page: Page, expectedStatus = 303) {
  // mockoidc immediately redirects to the real app callback with a signed code.
  const callback = page.waitForResponse(response => new URL(response.url()).pathname === "/auth/callback");
  await page.getByRole("link", { name: "Sign in with SSO" }).click();
  expect((await callback).status()).toBe(expectedStatus);
}

export async function openLedger(page: Page, url: string) {
  await page.goto(url);
  await signIn(page);
  await expect(homeHeading(page)).toBeVisible();
}

export async function setup(page: Page, url: string, timeZone = "Europe/Istanbul") {
  await page.goto(url);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Set up your ledger" })).toBeVisible();
  await page.getByLabel("Ledger time zone").fill(timeZone);
  await button(page, "Confirm time zone").click();
  await expect(homeHeading(page)).toBeVisible();
  await synced(page);
}

export async function synced(page: Page) {
  await expect(page.getByRole("link", { name: "Family Tab", exact: true })).toBeVisible();
  await expect(syncStatus(page)).toBeHidden();
}

export async function snapshot(page: Page): Promise<Snapshot> {
  const response = await page.request.get(new URL("/api/snapshot", page.url()).href, { headers: apiHeader });
  expect(response.status(), "authenticated server snapshot").toBe(200);
  return response.json();
}

export async function person(page: Page, name = "Mom") {
  await page.getByRole("link", { name: new RegExp(`^${name} `) }).first().click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

export async function settings(page: Page) {
  await page.getByRole("link", { name: "Family Tab", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Menu" }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}

export async function save(dialog: Locator) {
  await button(dialog, "Save").click();
  await expect(dialog).toBeHidden();
}

export async function purchase(page: Page, fields: {
  item: string;
  price: string;
  newPerson?: string;
  payday?: string;
  firstDue?: string;
  dueDate?: string;
  boughtOn?: string;
}) {
  await page.getByRole("button", { name: /^\+?\s*Add purchase$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Add purchase" });
  if (fields.newPerson) {
    await button(dialog, "+ New person").click();
    const name = dialog.getByLabel("Name", { exact: true });
    await expect(name).toBeFocused();
    await name.fill(fields.newPerson);
    if (fields.payday) await dialog.getByLabel("Payday (optional)").fill(fields.payday);
  }
  await dialog.getByLabel("What", { exact: true }).fill(fields.item);
  await dialog.getByLabel("Total price").fill(fields.price);
  if (fields.firstDue) {
    await button(dialog, "In installments").click();
    await button(dialog, "6").click();
    await dialog.getByLabel("First due date").fill(fields.firstDue);
  } else if (fields.dueDate) {
    await button(dialog, "Custom date").click();
    await dialog.getByLabel("Custom due date").fill(fields.dueDate);
  }
  if (fields.boughtOn) {
    await dialog.getByText("Purchase date and note", { exact: true }).click();
    await dialog.getByLabel("Purchase date", { exact: true }).fill(fields.boughtOn);
  }
  await save(dialog);
}

export async function seedPerson(page: Page, url: string) {
  await setup(page, url);
  await purchase(page, { item: "Kitchen towels", price: "100", newPerson: "Mom" });
  await person(page);
  await synced(page);
}

export async function cash(page: Page, amount: string, options: {
  fromMinor?: number;
  payout?: boolean;
  date?: string;
  note?: string;
} = {}) {
  const action = options.fromMinor !== undefined ? `Edit payment of ${money(options.fromMinor)}`
    : options.payout ? "Record cash returned" : "Record a payment";
  const dialogName = options.fromMinor !== undefined ? "Edit payment" : action;
  await button(page, action).click();
  const dialog = page.getByRole("dialog", { name: dialogName });
  await dialog.getByLabel("Amount", { exact: true }).fill(amount);
  if (options.date) await dialog.getByLabel("Date", { exact: true }).fill(options.date);
  if (options.note) await dialog.getByLabel("Note (optional)").fill(options.note);
  await save(dialog);
}

export async function figure(page: Page, label: string, value: number) {
  // Each term is immediately followed by its amount in the definition list.
  await expect(page.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) })
    .locator("+ dd")).toHaveText(money(value));
}

export async function goOffline(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.context().setOffline(true);
  await expect(syncStatus(page)).toContainText("Offline");
}

export async function review(page: Page, title: string) {
  await page.getByRole("link", { name: "Review changes" }).click();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(card).toBeVisible();
  return card;
}

export async function sessionCookie(page: Page): Promise<string> {
  const cookie = (await page.context().cookies(page.url())).find(entry => entry.name === "ft_session");
  if (!cookie) throw new Error("The browser did not receive an ft_session cookie");
  return `${cookie.name}=${cookie.value}`;
}
