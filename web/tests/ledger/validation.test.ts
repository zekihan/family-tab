import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidTimeZone, validateChange, validateRecords } from "../../src/ledger/index.ts";
import type { Change } from "../../src/ledger/index.ts";
import type { Payout, Records } from "../../src/types.ts";
import { ledger, payment, person, purchase, refund, settings, today } from "./records.ts";

const payout: Payout = { id: "payout", personId: person.id, amountMinor: 300, paidOutOn: today, note: null, version: "1" };
const createSettings: Change = { kind: "create", recordType: "settings", recordId: "ledger" };
const updatePurchase: Change = { kind: "update", recordType: "purchase", recordId: purchase.id };
const updatePayment: Change = { kind: "update", recordType: "payment", recordId: payment.id };
const createPayout: Change = { kind: "create", recordType: "payout", recordId: payout.id };
const updatePayout: Change = { ...createPayout, kind: "update" };

test("setup is the only allowed operation before settings exist", () => {
  const before = ledger({ settings: null, people: [] });
  const after = ledger({ people: [] });
  assert.equal(validateChange(before, after, createSettings, today), null);
  assert.equal(validateChange(before, after, { ...createSettings, kind: "update" }, today)?.code, "not_setup");
  assert.equal(validateChange(before, ledger({ settings: null }), {
    kind: "create", recordType: "person", recordId: person.id,
  }, today)?.code, "not_setup");
  assert.equal(validateChange(after, after, createSettings, today)?.code, "duplicate_id");
  assert.equal(validateChange(before, after, { ...createSettings, recordId: "other" }, today)?.code, "invalid");
  assert.equal(validateChange(ledger({ settings: null, people: [{ ...person, id: "ledger" }] }), after, createSettings, today)?.code, "duplicate_id");
  assert.equal(validateRecords(before, today)?.code, "invalid");
});

test("settings must use TRY and an IANA time zone, and only the time zone can be edited", () => {
  for (const zone of ["UTC", "Europe/Istanbul", "Etc/GMT+3"]) assert.equal(isValidTimeZone(zone), true, zone);
  for (const zone of ["", "Local", "Bogus/City", "+03:00", "-0500"]) assert.equal(isValidTimeZone(zone), false, zone);

  const before = ledger();
  const update = { ...createSettings, kind: "update" } as const;
  const changeZone = (timeZone: string) => ledger({ settings: { ...settings, timeZone, version: "2" } });
  assert.equal(validateChange(before, changeZone("Europe/Istanbul"), update, today), null);
  assert.equal(validateChange(before, changeZone("+03:00"), update, today)?.code, "invalid");
  const otherCurrency = ledger({ settings: { ...settings, currency: "USD" as "TRY" } });
  assert.equal(validateChange(before, otherCurrency, update, today)?.code, "invalid");
  assert.equal(validateRecords(otherCurrency, today)?.code, "invalid");
  assert.equal(validateChange(before, ledger({ settings: null }), { ...update, kind: "delete" }, today)?.code, "invalid");
});

test("record limits apply in a restore, including Unicode character counts", () => {
  const personAtLimit = { ...person, name: "ş".repeat(200), payday: 31 };
  const purchaseAtLimit = { ...purchase, item: "🧺".repeat(200), note: "🧺".repeat(500), totalMinor: 10_000_000_000 };
  const records = ledger({ people: [personAtLimit], purchases: [purchaseAtLimit] });
  assert.equal(validateRecords(records, today), null);
  const invalidCases: Partial<Records>[] = [
    { people: [{ ...person, name: " \t\n" }] },
    { people: [{ ...personAtLimit, name: personAtLimit.name + "a" }] },
    { people: [{ ...person, payday: 1.5 }] },
    { purchases: [{ ...purchase, item: " " }] },
    { purchases: [{ ...purchaseAtLimit, item: purchaseAtLimit.item + "🧺" }] },
    { purchases: [{ ...purchaseAtLimit, note: purchaseAtLimit.note + "🧺" }] },
    { purchases: [{ ...purchase, totalMinor: 0 }] },
    { purchases: [{ ...purchase, totalMinor: 1.25 }] },
    { purchases: [{ ...purchase, boughtOn: "2025-02-29" }] },
    { purchases: [{ ...purchase, count: 2 }] },
    { purchases: [{ ...purchase, dueDate: "2025-02-30" }] },
    { payments: [{ ...payment, amountMinor: -1 }] },
    { payouts: [{ ...payout, paidOutOn: "2025-11-23" }] },
  ];
  for (const changes of invalidCases) {
    assert.equal(validateRecords({ ...records, ...changes }, today)?.code, "invalid", JSON.stringify(changes));
  }
  assert.equal(validateRecords(ledger({ people: [{ ...person, id: settings.id }] }), today)?.code, "duplicate_id");
  assert.equal(validateRecords(ledger({ payouts: [{ ...payout, personId: "missing" }] }), today)?.code, "not_found");
  assert.equal(validateRecords(ledger({ refunds: [refund] }), today)?.code, "not_found");
});

test("a restore allows archived purchases and cash shortfalls", () => {
  assert.equal(validateRecords(ledger({
    people: [{ ...person, archived: true }],
    purchases: [purchase], payouts: [payout],
  }), today), null);
});

test("future-date checks apply per field and only to new or changed dates", () => {
  const future = "2025-11-23";
  const purchaseFromPreviousZone = { ...purchase, boughtOn: future };
  const futureRefund = { ...refund, refundedOn: future };
  const futurePayment = { ...payment, paidOn: future };
  const before = ledger({
    purchases: [purchaseFromPreviousZone], refunds: [futureRefund], payments: [futurePayment], payouts: [payout],
  });

  const next = {
    ...before,
    settings: { ...settings, timeZone: "America/Los_Angeles" },
    payments: [{ ...futurePayment, note: "cash" }],
    purchases: [{ ...purchaseFromPreviousZone, note: "revised", dueDate: "2025-12-01" }],
  };
  assert.equal(validateChange(before, next, { ...createSettings, kind: "update" }, today), null);
  assert.equal(validateChange(before, next, updatePayment, today), null);
  assert.equal(validateChange(before, next, updatePurchase, today), null);
  assert.equal(validateChange(before, next, { kind: "update", recordType: "refund", recordId: refund.id }, today), null);
  assert.equal(validateChange(before, { ...next, payments: [{ ...futurePayment, paidOn: "2025-11-24" }] }, updatePayment, today)?.code, "invalid");
  assert.equal(validateChange(before, { ...next, payouts: [{ ...payout, paidOutOn: future }] }, updatePayout, today)?.code, "invalid");

  const reversed = { ...before, purchases: [{ ...purchase, boughtOn: "2025-11-22" }], refunds: [{ ...refund, refundedOn: "2025-11-21" }] };
  assert.equal(validateChange(ledger({ purchases: [purchase], refunds: reversed.refunds }), reversed, updatePurchase, today)?.code, "invalid");
});

test("change validation ignores unrelated records and checks after-change references", () => {
  const before = ledger({ people: [person, { ...person, id: "dad", name: "" }], payments: [payment] });
  const edited = { ...payment, note: "cash" };
  assert.equal(validateChange(before, { ...before, payments: [edited] }, updatePayment, today), null);
  assert.equal(validateChange(before, { ...before, people: [], payments: [edited] }, updatePayment, today)?.code, "not_found");
  assert.equal(validateChange(ledger(), { ...before, payments: [edited] }, updatePayment, today)?.code, "conflict");
  assert.equal(validateChange(before, { ...before, payments: [] }, updatePayment, today)?.code, "invalid");

  const refundBefore = ledger({ purchases: [purchase, { ...purchase, id: "other" }], refunds: [refund] });
  const refundAfter = { ...refundBefore, refunds: [{ ...refund, purchaseId: "other" }] };
  const change: Change = { kind: "update", recordType: "refund", recordId: refund.id };
  assert.equal(validateChange(refundBefore, refundAfter, change, today)?.code, "invalid");
});

test("deletion reports all blocking record IDs", () => {
  const records = ledger({
    purchases: [purchase],
    payments: [payment],
    payouts: [payout],
    refunds: [{ ...refund, id: "refund-z" }, { ...refund, id: "refund-a" }],
  });
  const deletePurchase: Change = { ...updatePurchase, kind: "delete" };
  const purchaseError = validateChange(records, { ...records, purchases: [] }, deletePurchase, today);
  assert.equal(purchaseError?.code, "purchase_has_refunds");
  assert.deepEqual(purchaseError?.blocking, ["refund-a", "refund-z"]);

  const deletePerson: Change = { kind: "delete", recordType: "person", recordId: person.id };
  const personError = validateChange(records, { ...records, people: [] }, deletePerson, today);
  assert.equal(personError?.code, "person_has_records");
  assert.deepEqual(personError?.blocking, [purchase.id, payment.id, payout.id]);
});

test("payout checks use destination credit without the candidate payout", () => {
  const before = ledger({
    purchases: [purchase],
    refunds: [refund],
    payments: [{ ...payment, amountMinor: 1_000 }],
    payouts: [{ ...payout, id: "previous-payout", amountMinor: 200 }],
  });
  const atCredit = { ...payout, amountMinor: 400 };
  const withPayout = { ...before, payouts: [...before.payouts, atCredit] };
  assert.equal(validateChange(before, withPayout, createPayout, today), null);
  const excessive = { ...before, payouts: [...before.payouts, { ...atCredit, amountMinor: 401 }] };
  assert.equal(validateChange(before, excessive, createPayout, today)?.code, "payout_exceeds_credit");
  assert.equal(validateChange(withPayout, excessive, updatePayout, today)?.code, "payout_exceeds_credit");
  assert.equal(validateChange(withPayout, excessive, { ...updatePayout, alreadyReturned: true }, today), null);

  const insufficient = { ...withPayout, payments: [{ ...payment, amountMinor: 100 }] };
  const decreasing = { ...insufficient, payouts: [...before.payouts, { ...atCredit, amountMinor: 350 }] };
  assert.equal(validateChange(insufficient, decreasing, updatePayout, today), null);
});
