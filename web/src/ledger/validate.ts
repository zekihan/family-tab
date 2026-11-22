import { SETTINGS_ID } from "../types.ts";
import type { Person, Purchase, ReceiptCode, RecordByType, Records, RecordType, Refund, Settings } from "../types.ts";
import type { Change, RuleError } from "./index.ts";
import { isValidDate, isValidTimeZone } from "./dates.ts";
import { isValidAmount } from "./limits.ts";
import { installmentPreview } from "./schedule.ts";
import { computeLedger } from "./balance.ts";
import { validateAliasConflicts, validateAliases } from "./names.ts";

function rule(code: ReceiptCode, reason: string, blocking: string[] = []): RuleError {
  return { code, reason, blocking };
}

function hasText(value: string, limit: number): boolean {
  return typeof value === "string" && /[^\p{White_Space}]/u.test(value) && [...value].length <= limit;
}

function validNote(note: string | null): boolean {
  return note === null || (typeof note === "string" && [...note].length <= 500);
}

function validEventDate(date: string, today: string, previousDate?: string): boolean {
  return isValidDate(date) && (date === previousDate || date <= today);
}

function validateSettings(settings: Settings | null): RuleError | null {
  if (settings === null || settings.id !== SETTINGS_ID || settings.currency !== "TRY") {
    return rule("invalid", "Invalid ledger settings.");
  }
  return isValidTimeZone(settings.timeZone) ? null : rule("invalid", "Invalid ledger time zone.");
}

function validatePerson(person: Person): RuleError | null {
  const { name, payday } = person;
  if (!hasText(name, 200) || (payday !== null && (!Number.isInteger(payday) || payday < 1 || payday > 31))) {
    return rule("invalid", "Invalid person name or payday.");
  }
  return validateAliases(person);
}

function validatePurchase(purchase: Purchase, person: Person | undefined, today: string, previous?: Purchase): RuleError | null {
  if (!person) return rule("not_found", "Person not found.");
  const { item, note, totalMinor, boughtOn, plan, dueDate, count, dueDay, firstDue } = purchase;
  if (!hasText(item, 200) || !validNote(note) || !isValidAmount(totalMinor) || !validEventDate(boughtOn, today, previous?.boughtOn)) {
    return rule("invalid", "Invalid purchase item, note, amount, or purchase date.");
  }
  if (plan === "once") {
    if (count !== null || dueDay !== null || firstDue !== null) {
      return rule("invalid", "A one-time purchase cannot have installment fields.");
    }
    if (dueDate !== null && (!isValidDate(dueDate) || dueDate < boughtOn)) {
      return rule("invalid", "Invalid due date.");
    }
  } else if (plan !== "installments" || dueDate !== null || count === null || dueDay === null || firstDue === null
    || firstDue < boughtOn || !installmentPreview(totalMinor, count, firstDue, dueDay)) {
    return rule("invalid", "Invalid installment schedule.");
  }
  return null;
}

function validateCash(
  entry: { amountMinor: number; note: string | null },
  person: Person | undefined,
  date: string,
  today: string,
  previousDate?: string,
): RuleError | null {
  if (!person) return rule("not_found", "Person not found.");
  if (!isValidAmount(entry.amountMinor) || !validNote(entry.note) || !validEventDate(date, today, previousDate)) {
    return rule("invalid", "Invalid cash amount, date, or note.");
  }
  return null;
}

function validateRefund(refund: Refund, purchase: Purchase | undefined, today: string, previous?: Refund): RuleError | null {
  if (!purchase) return rule("not_found", "Purchase not found.");
  const { refundedOn, amountMinor, note } = refund;
  if (!isValidAmount(amountMinor) || !validNote(note) || !validEventDate(refundedOn, today, previous?.refundedOn)
    || refundedOn < purchase.boughtOn) {
    return rule("invalid", "Invalid refund amount, date, or note.");
  }
  return null;
}

function validateRefundTotal(purchase: Purchase, refunded: number): RuleError | null {
  return refunded > purchase.totalMinor ? rule("refunds_exceed_total", "Refunds exceed the purchase total.") : null;
}

function sameAliases(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((alias, index) => alias === b[index]);
}

function recordGroups(records: Records): { [K in RecordType]: RecordByType[K][] } {
  return {
    settings: records.settings ? [records.settings] : [],
    person: records.people,
    purchase: records.purchases,
    payment: records.payments,
    refund: records.refunds,
    payout: records.payouts,
  };
}

function findById<T extends { id: string }>(records: T[], id: string): T | undefined {
  return records.find(record => record.id === id);
}

/** Record rules over a whole ledger (as for a restore). */
export function validateRecords(records: Records, today: string): RuleError | null {
  if (!isValidDate(today)) return rule("invalid", "Invalid current date.");
  const settingsError = validateSettings(records.settings);
  if (settingsError) return settingsError;
  const ids = new Set<string>([SETTINGS_ID]);
  const checkId = (id: string): RuleError | null => {
    if (ids.has(id)) return rule("duplicate_id", "The record ID already exists.");
    ids.add(id);
    return null;
  };

  const people = new Map(records.people.map(person => [person.id, person]));
  const purchases = new Map(records.purchases.map(purchase => [purchase.id, purchase]));
  for (const person of records.people) {
    const error = checkId(person.id) ?? validatePerson(person);
    if (error) return error;
  }
  for (const purchase of records.purchases) {
    const error = checkId(purchase.id) ?? validatePurchase(purchase, people.get(purchase.personId), today);
    if (error) return error;
  }
  for (const payment of records.payments) {
    const error = checkId(payment.id) ?? validateCash(payment, people.get(payment.personId), payment.paidOn, today);
    if (error) return error;
  }
  const refundTotals = new Map<string, number>();
  for (const refund of records.refunds) {
    const purchase = purchases.get(refund.purchaseId);
    const error = checkId(refund.id) ?? validateRefund(refund, purchase, today);
    if (error) return error;
    const refunded = (refundTotals.get(refund.purchaseId) ?? 0) + refund.amountMinor;
    refundTotals.set(refund.purchaseId, refunded);
  }
  for (const payout of records.payouts) {
    const error = checkId(payout.id) ?? validateCash(payout, people.get(payout.personId), payout.paidOutOn, today);
    if (error) return error;
  }
  for (const purchase of records.purchases) {
    const error = validateRefundTotal(purchase, refundTotals.get(purchase.id) ?? 0);
    if (error) return error;
  }
  for (const person of records.people) {
    const error = validateAliasConflicts(records.people, person);
    if (error) return error;
  }
  return null;
}

function validateDeletion(after: Records, type: RecordType, id: string): RuleError | null {
  if (type === "purchase") {
    const blocking = after.refunds.filter(refund => refund.purchaseId === id).map(refund => refund.id).sort();
    if (blocking.length > 0) return rule("purchase_has_refunds", "This purchase still has refunds.", blocking);
  }
  if (type === "person") {
    const blocking = [...after.purchases, ...after.payments, ...after.payouts]
      .filter(record => record.personId === id).map(record => record.id).sort();
    if (blocking.length > 0) return rule("person_has_records", "This person still has ledger records.", blocking);
  }
  return null;
}

/** Record rules on the touched records plus change rules, comparing before and after. */
export function validateChange(before: Records, after: Records, change: Change, today: string): RuleError | null {
  const { kind, recordType, recordId } = change;
  const setup = recordType === "settings" && kind === "create";
  if (before.settings === null && !setup) return rule("not_setup", "Set up the ledger first.");
  if (!isValidDate(today)) return rule("invalid", "Invalid current date.");

  const previous = recordGroups(before);
  const next = recordGroups(after);
  if (recordType === "settings") {
    if (recordId !== SETTINGS_ID) return rule("invalid", "Settings must use the ledger ID.");
    if (kind === "delete") return rule("invalid", "Ledger settings cannot be deleted.");
    if (setup && before.settings !== null) return rule("duplicate_id", "Ledger settings already exist.");
    if (kind === "update" && (after.settings?.id !== before.settings?.id || after.settings?.currency !== before.settings?.currency)) {
      return rule("invalid", "Only the ledger time zone can change.");
    }
  }
  if (kind === "create") {
    if (Object.values(previous).some(group => group.some(record => record.id === recordId))) {
      return rule("duplicate_id", "The record ID already exists.");
    }
  } else if (!previous[recordType].some(record => record.id === recordId)) {
    return rule("conflict", "The record no longer exists.");
  }
  const existsAfter = next[recordType].some(record => record.id === recordId);
  if (kind === "delete") {
    return existsAfter ? rule("invalid", "The deleted record is still present.") : validateDeletion(after, recordType, recordId);
  }
  if (!existsAfter) return rule("invalid", "The changed record is missing.");

  switch (recordType) {
    case "settings":
      return validateSettings(after.settings);
    case "person": {
      const person = findById(next.person, recordId)!;
      const prior = findById(previous.person, recordId);
      const error = validatePerson(person);
      if (error || (prior && prior.name === person.name && sameAliases(prior.aliases, person.aliases))) return error;
      return validateAliasConflicts(next.person, person);
    }
    case "purchase": {
      const purchase = findById(next.purchase, recordId)!;
      const prior = findById(previous.purchase, recordId);
      const person = findById(next.person, purchase.personId);
      const error = validatePurchase(purchase, person, today, prior);
      if (error) return error;
      const refunds = next.refund.filter(refund => refund.purchaseId === purchase.id);
      const totalError = validateRefundTotal(purchase, refunds.reduce((sum, refund) => sum + refund.amountMinor, 0));
      if (totalError) return totalError;
      if (refunds.some(({ refundedOn }) => !isValidDate(refundedOn) || refundedOn < purchase.boughtOn)) {
        return rule("invalid", "Invalid refund date for this purchase.");
      }
      if (person?.archived && prior?.personId !== purchase.personId) {
        return rule("archived_person", "A new or moved purchase requires an active person.");
      }
      return null;
    }
    case "payment": {
      const payment = findById(next.payment, recordId)!;
      const prior = findById(previous.payment, recordId);
      return validateCash(payment, findById(next.person, payment.personId), payment.paidOn, today, prior?.paidOn);
    }
    case "refund": {
      const refund = findById(next.refund, recordId)!;
      const prior = findById(previous.refund, recordId);
      const purchase = findById(next.purchase, refund.purchaseId);
      const error = validateRefund(refund, purchase, today, prior);
      if (error) return error;
      if (prior && prior.purchaseId !== refund.purchaseId) {
        return rule("invalid", "A refund cannot move to a different purchase.");
      }
      const refunded = next.refund.reduce((sum, entry) => sum + (entry.purchaseId === refund.purchaseId ? entry.amountMinor : 0), 0);
      return validateRefundTotal(purchase!, refunded);
    }
    case "payout": {
      const payout = findById(next.payout, recordId)!;
      const prior = findById(previous.payout, recordId);
      const person = findById(next.person, payout.personId);
      const error = validateCash(payout, person, payout.paidOutOn, today, prior?.paidOutOn);
      if (error) return error;
      if (change.alreadyReturned || (prior?.personId === payout.personId && payout.amountMinor <= prior.amountMinor)) {
        return null;
      }
      const withoutPayout: Records = {
        ...after,
        people: [person!],
        payouts: after.payouts.filter(entry => entry.id !== payout.id),
      };
      const { credit } = computeLedger(withoutPayout, today).balances[payout.personId];
      return payout.amountMinor > credit ? rule("payout_exceeds_credit", "The payout exceeds this person's credit.") : null;
    }
  }
}
