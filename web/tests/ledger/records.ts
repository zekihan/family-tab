import type { Payment, Person, Purchase, Records, Refund, Settings } from "../../src/types.ts";

export const today = "2025-11-22";
export const settings: Settings = { id: "ledger", timeZone: "UTC", currency: "TRY", version: "1" };
export const person: Person = { id: "mom", name: "Mom", aliases: [], archived: false, payday: null, version: "1" };
export const purchase: Purchase = {
  id: "p", personId: person.id, item: "Vacuum", totalMinor: 600, boughtOn: "2025-08-01",
  plan: "once", count: null, dueDate: null, dueDay: null, firstDue: null, note: null, source: "app", version: "1",
};
export const payment: Payment = { id: "pay", personId: person.id, amountMinor: 500, paidOn: today, note: null, source: "app", version: "1" };
export const refund: Refund = {
  id: "refund", purchaseId: purchase.id, amountMinor: 200, refundedOn: today, note: null, source: "app", version: "1",
};

export function ledger(overrides: Partial<Records> = {}): Records {
  return { settings, people: [person], purchases: [], payments: [], refunds: [], payouts: [], ...overrides };
}
