// Public API of the pure ledger module (DESIGN.md sections 5 and 8). Every
// function takes records and an explicit `today`; nothing here does I/O or
// uses JavaScript Date objects for calendar dates.
//
// This file fixes the signatures other modules build against. The
// implementation lives in sibling files and is re-exported from here.

import type {
  ComingUpEntry,
  DateString,
  HomeTotals,
  PaymentChip,
  PersonBalance,
  Purchase,
  Records,
  Refund,
  ReceiptCode,
  RecordType,
  ScheduledAmount,
  StatusChip,
} from "../types.ts";

const unimplemented = (): never => {
  throw new Error("unimplemented");
};

// ---- Dates (YYYY-MM-DD) ----

export function isValidDate(value: string): boolean {
  void value;
  return unimplemented();
}
export function compareDates(a: DateString, b: DateString): number {
  void a; void b;
  return unimplemented();
}
export function daysInMonth(year: number, month: number): number {
  void year; void month;
  return unimplemented();
}
/** Adds calendar days. */
export function addDays(date: DateString, days: number): DateString {
  void date; void days;
  return unimplemented();
}
/** Adds calendar months keeping `day` (default: the date's own day), clamped to month end. */
export function addMonths(date: DateString, months: number, day?: number): DateString {
  void date; void months; void day;
  return unimplemented();
}
/** The date in `day` of the given month, clamped to the month's last day. */
export function clampedDate(year: number, month: number, day: number): DateString {
  void year; void month; void day;
  return unimplemented();
}
export function lastDayOfMonth(date: DateString): DateString {
  void date;
  return unimplemented();
}
/** Today's calendar date in an IANA zone, via Intl.DateTimeFormat. `nowMs` defaults to Date.now(). */
export function todayIn(timeZone: string, nowMs?: number): DateString {
  void timeZone; void nowMs;
  return unimplemented();
}
export function isValidTimeZone(timeZone: string): boolean {
  void timeZone;
  return unimplemented();
}

// ---- Amounts ----

export type ParseAmountResult = { ok: true; minor: number } | { ok: false; error: string };

/** DESIGN.md section 8, Parsing amounts. */
export function parseAmount(input: string): ParseAmountResult {
  void input;
  return unimplemented();
}
/** Formats kuruş as TRY, e.g. "12.349,50 TL". */
export function formatTRY(minor: number): string {
  void minor;
  return unimplemented();
}
/** Formats kuruş as an editable input value, e.g. "12.349,50". */
export function formatAmountInput(minor: number): string {
  void minor;
  return unimplemented();
}

// ---- Schedules ----

export function buildSchedule(purchase: Purchase): ScheduledAmount[] {
  void purchase;
  return unimplemented();
}
export function adjustedSchedule(purchase: Purchase, refunds: Refund[]): ScheduledAmount[] {
  void purchase; void refunds;
  return unimplemented();
}

// ---- Date defaults for the Add purchase sheet (DESIGN.md section 6) ----

/** The first date on or after `today` whose day is `payday` clamped to its month. */
export function firstPaydayOnOrAfter(today: DateString, payday: number): DateString {
  void today; void payday;
  return unimplemented();
}

export interface DueShortcuts {
  payday: DateString | null; // null when the person has no payday
  endOfMonth: DateString;
  inTwoWeeks: DateString;
}
export function dueShortcuts(today: DateString, payday: number | null): DueShortcuts {
  void today; void payday;
  return unimplemented();
}

/** Default first due date and monthly anchor for a new installment plan. */
export function defaultInstallmentStart(
  today: DateString,
  payday: number | null,
): { firstDue: DateString; dueDay: number } {
  void today; void payday;
  return unimplemented();
}

export interface InstallmentPreview {
  count: number;
  first: DateString;
  last: DateString;
  minAmount: number;
  maxAmount: number;
}
/** Null when the plan is invalid (for example total below count). */
export function installmentPreview(
  totalMinor: number,
  count: number,
  firstDue: DateString,
  dueDay: number,
): InstallmentPreview | null {
  void totalMinor; void count; void firstDue; void dueDay;
  return unimplemented();
}

// ---- Balances (DESIGN.md section 5) ----

export interface PurchaseView {
  purchaseId: string;
  base: ScheduledAmount[];
  adjusted: ScheduledAmount[];
  /** Allocated amount per adjusted entry, same order as `adjusted`. */
  paid: number[];
  refundedMinor: number;
  leftMinor: number;
  /** Earliest dated amount that is not fully paid. */
  earliestUnpaidDue: DateString | null;
  paidCount: number; // entries with adjustedMinor > 0 that are fully paid
  payableCount: number; // entries with adjustedMinor > 0
}

export interface LedgerView {
  today: DateString;
  balances: Record<string, PersonBalance>;
  chips: Record<string, StatusChip>;
  purchases: Record<string, PurchaseView>;
  home: HomeTotals;
  comingUp: ComingUpEntry[];
  /** Active people in Home row order. */
  homeOrder: string[];
}

export function computeLedger(records: Records, today: DateString): LedgerView {
  void records; void today;
  return unimplemented();
}

/** Quick chips for Record a payment, only those with a positive amount. */
export function paymentChips(view: LedgerView, records: Records, personId: string): PaymentChip[] {
  void view; void records; void personId;
  return unimplemented();
}

// ---- Validation (DESIGN.md section 8, Validation rules) ----

export interface RuleError {
  code: ReceiptCode;
  reason: string;
  blocking: string[];
}

export interface Change {
  kind: "create" | "update" | "delete";
  recordType: RecordType;
  recordId: string;
  alreadyReturned?: boolean;
}

export const MAX_AMOUNT_MINOR = 10_000_000_000; // 100,000,000 TL

/** Record rules over a whole ledger (as for a restore). */
export function validateRecords(records: Records, today: DateString): RuleError | null {
  void records; void today;
  return unimplemented();
}

/** Record rules on the touched records plus change rules, comparing before and after. */
export function validateChange(
  before: Records,
  after: Records,
  change: Change,
  today: DateString,
): RuleError | null {
  void before; void after; void change; void today;
  return unimplemented();
}
