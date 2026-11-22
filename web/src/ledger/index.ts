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
  PersonBalance,
  ReceiptCode,
  RecordType,
  ScheduledAmount,
  StatusChip,
} from "../types.ts";

export * from "./dates.ts";
export * from "./amount.ts";
export * from "./schedule.ts";

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

export { computeLedger, paymentChips } from "./balance.ts";

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

export { MAX_AMOUNT_MINOR } from "./limits.ts";
export { validateRecords, validateChange } from "./validate.ts";
