import assert from "node:assert/strict";
import test from "node:test";
import { aliasAddError, dateInputText, eventDateMax, parseDateInput, patchBetween, personAliasError, purchaseDate, reviewReason, statusText } from "../../src/ui/presentation.ts";

test("caps only new or changed event dates at today", () => {
  const today = "2026-11-22";
  const savedDate = "2026-11-23";
  assert.equal(eventDateMax(savedDate, today, savedDate), undefined);
  assert.equal(eventDateMax("2026-11-24", today, savedDate), today);
  assert.equal(eventDateMax(savedDate, today), today);
  assert.equal(eventDateMax(savedDate, today, null), today);
});

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

test("date fields read and write day-first dates", () => {
  assert.equal(dateInputText("2026-12-05"), "05.12.2026");
  assert.equal(dateInputText(""), "");
  assert.equal(parseDateInput("05.12.2026"), "2026-12-05");
  assert.equal(parseDateInput(" 5.12.2026 "), "2026-12-05");
  assert.equal(parseDateInput("5/2/2028"), "2028-02-05");
  assert.equal(parseDateInput("2026-12-05"), "2026-12-05");
  assert.equal(parseDateInput("29.02.2028"), "2028-02-29");
  assert.equal(parseDateInput("29.02.2027"), null);
  assert.equal(parseDateInput("31.04.2026"), null);
  assert.equal(parseDateInput("12/15/2026"), null);
  assert.equal(parseDateInput("5.12.26"), null);
  assert.equal(parseDateInput(""), null);
});

const person = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases, payday: null, archived: false, version: "1" });

test("validates person aliases with the shared rules", () => {
  const people = [person("a", "Mom", ["Anne"]), person("b", "Dad")];
  assert.equal(personAliasError(people, "a", "Mom", ["Anne", "Annecim"]), null);
  assert.match(personAliasError(people, "a", "Mom", ["mom"])!, /differ/);
  assert.match(personAliasError(people, "a", "Mom", ["X", "x"])!, /differ/);
  assert.match(personAliasError(people, "a", "Mom", ["DAD"])!, /matches Dad/);
  assert.match(personAliasError(people, "b", "Dad", ["ANNE"])!, /matches Mom/);
  assert.match(personAliasError(people, "a", "Mom", ["y".repeat(41)])!, /1 to 40/);
});

test("explains why an alias cannot be added", () => {
  const people = [person("a", "Mom"), person("b", "Dad")];
  assert.equal(aliasAddError(people, "a", "Mom", [], ""), null);
  assert.equal(aliasAddError(people, "a", "Mom", [], "Anne"), null);
  assert.match(aliasAddError(people, "a", "Mom", [], "dad")!, /matches Dad/);
  assert.match(aliasAddError(people, "a", "Mom", ["Anne"], "ANNE")!, /already listed/);
  assert.match(aliasAddError(people, "a", "Mom", [], "MOM")!, /differ from the name/);
  assert.match(aliasAddError(people, "a", "Mom", [], "z".repeat(41))!, /at most 40/);
  assert.match(aliasAddError(people, "a", "Mom", Array.from({ length: 20 }, (_, i) => `n${i}`), "more")!, /at most 20/);
});

test("maps alias_conflict rejections to a friendly message", () => {
  assert.match(reviewReason("alias_conflict", "x"), /matches another person/);
  assert.equal(reviewReason("conflict", "server text"), "server text");
});
