import assert from "node:assert/strict";
import test from "node:test";
import { patchBetween, purchaseDate, statusText } from "../../src/ui/presentation.ts";

test("auto-backdates an untouched purchase date without pinning it after a plan change", () => {
  assert.deepEqual(purchaseDate(null, "2026-11-22", "2026-09-30"), {
    date: "2026-09-30", backdated: true, invalid: false,
  });
  assert.deepEqual(purchaseDate(null, "2026-11-22", null), {
    date: "2026-11-22", backdated: false, invalid: false,
  });
});

test("blocks a chosen purchase date after the first due date", () => {
  assert.deepEqual(purchaseDate("2026-11-01", "2026-11-22", "2026-10-31"), {
    date: "2026-11-01", backdated: false, invalid: true,
  });
  assert.equal(purchaseDate("2026-10-31", "2026-11-22", "2026-10-31").invalid, false);
});

test("a reapply patch includes only fields the buyer changed", () => {
  assert.deepEqual(patchBetween<{ item: string; note: string; dueDate: string | null }>({ item: "Vacuum", note: "Online", dueDate: "2026-11-22" }, {
    item: "Vacuum", note: "", dueDate: null,
  }), { note: "", dueDate: null });
});

test("status chips use ledger formatting and readable calendar dates", () => {
  assert.equal(statusText({ kind: "credit", amountMinor: 125050, behindPlan: false }), "1.250,50 TL credit");
  assert.equal(statusText({ kind: "nextDate", date: "2026-11-22", behindPlan: false }), "Next due 22 Nov 2026");
  assert.equal(statusText({ kind: "dueByToday", amountMinor: 1250, behindPlan: true }), "12,50 TL due by today");
  assert.equal(statusText({ kind: "allPaid", behindPlan: false }), "All paid");
  assert.equal(statusText({ kind: "whenTheyCan", behindPlan: false }), "When they can");
});
