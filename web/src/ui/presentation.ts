import { formatTRY } from "../ledger/index.ts";
import type { LedgerRecord, Operation, PaymentChip, StatusChip } from "../types.ts";
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

export function purchaseDate(entered: string | null, today: string, due: string | null) {
  const backdated = entered === null && due !== null && due < today;
  const date = backdated ? due : entered ?? today;
  return { date, backdated, invalid: !!due && date > due };
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
