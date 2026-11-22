import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  addDays, addMonths, adjustedSchedule, buildSchedule, clampedDate, compareDates, computeLedger, daysInMonth,
  defaultInstallmentStart, dueShortcuts, firstPaydayOnOrAfter, formatAmountInput, formatTRY, installmentPreview,
  isValidDate, lastDayOfMonth, MAX_AMOUNT_MINOR, parseAmount, todayIn, validateRecords,
} from "../../src/ledger/index.ts";
import type { Purchase, Records } from "../../src/types.ts";
import { ledger, purchase, today } from "./records.ts";

test("Gregorian calendar validation, clamping, and year rollover", () => {
  for (const date of ["1900-02-29", "2025-02-29", "2024-04-31", "2024-00-01", "2024-01-00", "0000-01-01", "2024-1-01", "2024-12-31\n"]) {
    assert.equal(isValidDate(date), false, JSON.stringify(date));
  }
  for (const date of ["2000-02-29", "2024-02-29", "0001-01-01", "9999-12-31"]) {
    assert.equal(isValidDate(date), true, date);
  }
  assert.equal(daysInMonth(1900, 2), 28);
  assert.equal(clampedDate(2024, 2, 31), "2024-02-29");
  assert.equal(lastDayOfMonth("2024-12-01"), "2024-12-31");
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2023-01-31", 1), "2023-02-28");
  assert.equal(addMonths("2024-02-29", -2), "2023-12-29");
  assert.equal(addMonths("2024-02-29", 1, 31), "2024-03-31");
  assert.equal(addDays("2024-02-28", 2), "2024-03-01");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29");
  assert.equal(addDays("2024-01-01", -1), "2023-12-31");
  assert.equal(addDays("2024-12-31", 1), "2025-01-01");
  assert.equal(compareDates("2024-12-31", "2025-01-01"), -1);
  assert.equal(compareDates("2025-01-01", "2024-12-31"), 1);
  assert.equal(compareDates("2025-01-01", "2025-01-01"), 0);
});

test("today uses the ledger's time zone", () => {
  const midnightUTC = 1_704_067_200_000;
  assert.equal(todayIn("Europe/Istanbul", midnightUTC), "2024-01-01");
  assert.equal(todayIn("America/Los_Angeles", midnightUTC), "2023-12-31");
});

test("amount formatting uses TRY groups and displays only nonzero fractions", () => {
  assert.equal(formatTRY(1_234_950), "12.349,50 TL");
  assert.equal(formatTRY(200_000), "2.000 TL");
  assert.equal(formatAmountInput(1_234_950), "12.349,50");
  assert.equal(formatAmountInput(200_000), "2.000");
  assert.equal(formatTRY(150_000), "1.500 TL");
  assert.equal(formatAmountInput(129_990), "1.299,90");
  assert.equal(formatAmountInput(-129_990), "-1.299,90");
  assert.deepEqual(parseAmount("1.299,90"), { ok: true, minor: 129_990 });
  assert.equal(parseAmount("-1.299,90").ok, false);
  assert.equal(parseAmount("100.000.000,01").ok, false);
  assert.equal(parseAmount("1 299,90").ok, false);
});

test("purchase date shortcuts use today and include today's payday", () => {
  assert.deepEqual(dueShortcuts("2024-02-29", 31), {
    payday: "2024-02-29", endOfMonth: "2024-02-29", inTwoWeeks: "2024-03-14",
  });
  assert.deepEqual(dueShortcuts("2024-12-25", null), {
    payday: null, endOfMonth: "2024-12-31", inTwoWeeks: "2025-01-08",
  });
  assert.equal(firstPaydayOnOrAfter("2024-02-26", 25), "2024-03-25");
  assert.deepEqual(defaultInstallmentStart("2024-01-31", null), { firstDue: "2024-02-29", dueDay: 31 });
  assert.deepEqual(defaultInstallmentStart("2024-02-28", 30), { firstDue: "2024-02-29", dueDay: 30 });
});

test("custom and month-end anchors produce different schedules after February", () => {
  const custom = { ...purchase, plan: "installments", count: 3, boughtOn: "2024-02-29", firstDue: "2024-02-29" } as const;
  assert.deepEqual(buildSchedule({ ...custom, dueDay: 29 }).map(amount => amount.dueOn), [
    "2024-02-29", "2024-03-29", "2024-04-29",
  ]);
  assert.deepEqual(buildSchedule({ ...custom, dueDay: 31 }).map(amount => amount.dueOn), [
    "2024-02-29", "2024-03-31", "2024-04-30",
  ]);
  assert.equal(validateRecords(ledger({ purchases: [{ ...custom, dueDay: 29 }] }), today), null);
  const laterPurchase = { ...custom, dueDay: 29, boughtOn: today };
  assert.equal(validateRecords(ledger({ purchases: [laterPurchase] }), today)?.code, "invalid");
});

test("installment preview gives date and amount bounds and rejects invalid plans", () => {
  assert.deepEqual(installmentPreview(100, 3, "2024-02-29", 31), {
    count: 3, first: "2024-02-29", last: "2024-04-30", minAmount: 33, maxAmount: 34,
  });
  assert.deepEqual(installmentPreview(1200, 6, "2025-09-15", 15), {
    count: 6, first: "2025-09-15", last: "2026-02-15", minAmount: 200, maxAmount: 200,
  });
  assert.equal(installmentPreview(2, 3, "2024-02-29", 31), null);
  assert.equal(installmentPreview(100, 3, "2024-02-28", 31), null);
  assert.equal(installmentPreview(100, 3, "9999-11-01", 1), null);
});

test("deleting a purchase reallocates receipts to remaining dated amounts before undated amounts", () => {
  const records = ledger({
    purchases: [
      { ...purchase, id: "first", totalMinor: 2_000, dueDate: "2025-11-10" },
      { ...purchase, id: "next", totalMinor: 800, dueDate: "2025-11-25" },
      { ...purchase, id: "undated", totalMinor: 100 },
    ],
    payments: [{ id: "payment", personId: "mom", amountMinor: 1_000, paidOn: today, note: null, source: "app", version: "1" }],
  });
  const before = computeLedger(records, today);
  assert.deepEqual(before.purchases.first.paid, [1_000]);
  assert.deepEqual(before.purchases.next.paid, [0]);
  const after = computeLedger({ ...records, purchases: records.purchases.slice(1) }, today);
  assert.deepEqual(after.purchases.next.paid, [800]);
  assert.deepEqual(after.purchases.undated.paid, [100]);
  assert.equal(after.balances.mom.credit, 100);
});

test("credit covers a later purchase and stays with the person who paid", () => {
  const records = ledger({
    purchases: [{ ...purchase, id: "earlier", totalMinor: 100 }],
    payments: [{ id: "payment", personId: "mom", amountMinor: 250, paidOn: "2025-11-01", note: null, source: "app", version: "1" }],
  });
  assert.equal(computeLedger(records, today).balances.mom.credit, 150);
  const after = computeLedger({
    ...records,
    people: [...records.people, { ...records.people[0], id: "dad" }],
    purchases: [
      ...records.purchases,
      { ...purchase, id: "later", boughtOn: today, totalMinor: 60 },
      { ...purchase, id: "dad-purchase", personId: "dad", totalMinor: 100 },
    ],
  }, today);
  assert.deepEqual(after.purchases.later.paid, [60]);
  assert.equal(after.balances.mom.credit, 90);
  assert.equal(after.balances.dad.leftToPay, 100);
  assert.equal(after.home.leftToPay, 100);
});

test("TRY amount input round-trips all representable entry amounts", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: MAX_AMOUNT_MINOR }), minor => {
    assert.deepEqual(parseAmount(formatAmountInput(minor)), { ok: true, minor });
  }), { numRuns: 300 });
});

const installment = {
  ...purchase, plan: "installments", firstDue: "2025-09-30", dueDay: 31,
} as const;

test("installments sum to the total and spread the remainder over the first entries", () => {
  fc.assert(fc.property(
    fc.integer({ min: 2, max: 120 }),
    fc.integer({ min: 0, max: MAX_AMOUNT_MINOR - 120 }),
    (count, extra) => {
      const totalMinor = count + extra;
      const amounts = buildSchedule({ ...installment, count, totalMinor }).map(entry => entry.baseMinor);
      assert.equal(amounts.length, count);
      assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), totalMinor);
      assert.ok(amounts.every(amount => amount > 0));
      assert.ok(amounts.every((amount, index) => index === 0 || amounts[index - 1] >= amount));
      assert.ok(amounts[0] - amounts.at(-1)! <= 1);
    },
  ), { numRuns: 300 });
});

const smallAmount = fc.integer({ min: 1, max: 500 });
const recordsArb = fc.record({
  purchases: fc.array(fc.record({
    amount: smallAmount,
    count: fc.option(fc.integer({ min: 2, max: 8 }), { nil: null }),
    dueDate: fc.constantFrom("2025-11-15", today, "2025-12-01", null),
    refund: fc.integer({ min: 0, max: 300 }),
  }), { maxLength: 6 }),
  payments: fc.array(smallAmount, { maxLength: 6 }),
  payouts: fc.array(smallAmount, { maxLength: 3 }),
}).map(input => {
  const purchases: Purchase[] = input.purchases.map(({ amount, count, dueDate }, index) => {
    const id = `purchase-${index}`;
    return count === null
      ? { ...purchase, id, totalMinor: amount, dueDate }
      : { ...installment, id, count, totalMinor: amount + count };
  });
  return ledger({
    purchases,
    refunds: input.purchases.flatMap(({ refund }, index) => refund > 0 ? [{
      id: `refund-${index}`, purchaseId: purchases[index].id, amountMinor: Math.min(refund, purchases[index].totalMinor),
      note: null, source: "app", version: "1", refundedOn: today,
    }] : []),
    payments: input.payments.map((amountMinor, index) => ({
      id: `payment-${index}`, personId: "mom", amountMinor, note: null, paidOn: today, source: "app", version: "1",
    })),
    payouts: input.payouts.map((amountMinor, index) => ({
      id: `payout-${index}`, personId: "mom", amountMinor, note: null, paidOutOn: today, version: "1",
    })),
  } satisfies Partial<Records>);
});

test("allocation is bounded by receipts, debt includes shortfall, and credit excludes unpaid purchases", () => {
  fc.assert(fc.property(recordsArb, records => {
    const view = computeLedger(records, today);
    const balance = view.balances.mom;
    let allocated = 0;
    let unpaid = 0;
    for (const purchase of records.purchases) {
      const detail = view.purchases[purchase.id];
      const expectedTotal = adjustedSchedule(purchase, records.refunds).reduce((sum, entry) => sum + entry.adjustedMinor, 0);
      const paid = detail.paid.reduce((sum, minor) => sum + minor, 0);
      assert.equal(detail.leftMinor, expectedTotal - paid);
      allocated += paid;
      unpaid += detail.leftMinor;
    }
    const available = Math.max(0, balance.netReceipts);
    assert.ok(allocated <= available);
    assert.equal(allocated + balance.credit, available);
    assert.equal(balance.cashShortfall, Math.max(0, -balance.netReceipts));
    assert.equal(balance.leftToPay, unpaid + balance.cashShortfall);
    if (balance.credit > 0) assert.equal(unpaid, 0);
  }), { numRuns: 300 });
});
