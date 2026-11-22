import {
  aliasConflicts, formatTRY, isValidDate, MAX_ALIAS_LENGTH, MAX_ALIASES, normalizeName, trimName, validateAliases,
} from "../ledger/index.ts";
import type { LedgerRecord, Person, Operation, PaymentChip, StatusChip } from "../types.ts";
import type { ReviewItem } from "../data/index.ts";

export function statusText(chip: StatusChip) {
  switch (chip.kind) {
    case "credit": return `${formatTRY(chip.amountMinor)} credit`;
    case "allPaid": return "All paid";
    case "dueByToday": return `${formatTRY(chip.amountMinor)} due by today`;
    case "nextDate": return `Next due ${displayDate(chip.date)}`;
    case "whenTheyCan": return "When they can";
  }
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function displayDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

/** Formats YYYY-MM-DD as the day-first field value DD.MM.YYYY. */
export function dateInputText(date: string) {
  const [year, month, day] = date.split("-");
  return date ? `${day}.${month}.${year}` : "";
}

/** Parses DD.MM.YYYY (also D.M.YYYY, with / or - separators) or YYYY-MM-DD; null when not a real date. */
export function parseDateInput(text: string): string | null {
  const value = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const dayFirst = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(value);
  const date = iso ? value
    : dayFirst ? `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}` : null;
  return date && isValidDate(date) ? date : null;
}

export function purchaseDate(entered: string | null, today: string, due: string | null) {
  const backdated = entered === null && due !== null && due < today;
  const date = backdated ? due : entered ?? today;
  return { date, backdated, invalid: !!due && date > due };
}

export function eventDateMax(date: string, today: string, originalDate?: string | null) {
  return date === originalDate ? undefined : today;
}

export function patchBetween<T extends object>(before: Partial<T>, after: T): Partial<T> {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => before[key as keyof T] !== value)) as Partial<T>;
}

export const paymentLabels: Record<PaymentChip["kind"], string> = {
  dueByToday: "Due by today",
  throughNextDue: "Through next due date",
  everything: "Everything",
};

export const recordLabels: Record<Operation["recordType"], string> = {
  settings: "ledger settings",
  person: "person",
  purchase: "purchase",
  payment: "payment",
  refund: "shop refund",
  payout: "cash return",
};

export function recordName(record: LedgerRecord | null) {
  if (!record) return null;
  if ("name" in record) return record.name;
  if ("item" in record) return record.item;
  if ("amountMinor" in record) return formatTRY(record.amountMinor);
  return record.timeZone;
}

export function reviewActions(item: ReviewItem) {
  const canKeep = item.restore || item.code === "conflict" || item.code === "not_found";
  return {
    keep: canKeep,
    keepServer: !item.restore && (item.code === "conflict" || item.code === "not_found"),
    edit: item.op.kind !== "delete",
    confirmPayout: item.op.kind !== "delete" && item.op.recordType === "payout" && item.code === "payout_exceeds_credit",
  };
}

/** The message shown for a rejected change; known codes get a friendlier text than the server's. */
export function reviewReason(code: string | null, reason: string) {
  return code === "alias_conflict" ? "A name or alias matches another person. Change it so each person's names and aliases are unique." : reason;
}

/** The error blocking `aliases` for this person, using the shared validation and conflict rules. */
export function personAliasError(people: readonly Person[], id: string, name: string, aliases: string[]): string | null {
  const candidate = { id, name: trimName(name), aliases };
  const rule = validateAliases(candidate);
  if (rule) return rule.reason;
  const conflicts = aliasConflicts(people, candidate);
  if (conflicts.length) {
    return `A name or alias matches ${conflicts.map(other => people.find(row => row.id === other)?.name ?? other).join(", ")}.`;
  }
  return null;
}

/** Why `alias` cannot be added to the list, or null. */
export function aliasAddError(people: readonly Person[], id: string, name: string, aliases: string[], alias: string): string | null {
  if (alias === "") return null;
  if ([...alias].length > MAX_ALIAS_LENGTH) return `An alias can be at most ${MAX_ALIAS_LENGTH} characters.`;
  if (aliases.length >= MAX_ALIASES) return `A person can have at most ${MAX_ALIASES} aliases.`;
  const key = normalizeName(alias);
  if (key === normalizeName(name)) return "An alias must differ from the name.";
  if (aliases.some(existing => normalizeName(existing) === key)) return "That alias is already listed.";
  return personAliasError(people, id, name, [...aliases, alias]);
}
