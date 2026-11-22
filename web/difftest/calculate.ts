import { adjustedSchedule, buildSchedule, computeLedger, parseAmount, validateChange, validateRecords } from "../src/ledger/index.ts";
import { SETTINGS_ID } from "../src/types.ts";
import type { Operation, PersonBalance, ReceiptCode, Records, ScheduledAmount } from "../src/types.ts";
import type { LedgerCase } from "./generate.ts";

type SharedBalance = Pick<PersonBalance, "personId" | "paymentsReceived" | "cashReturned" | "netReceipts" | "credit" | "cashShortfall">;

export interface Result {
  schedules: Record<string, { base: ScheduledAmount[] | null; adjusted: ScheduledAmount[] | null }>;
  people: Record<string, SharedBalance>;
  valid: ReceiptCode | null;
  changes: { code: ReceiptCode | null; recordsCode: ReceiptCode | null }[];
  amounts: (number | null)[];
}

const collectionByType = {
  person: "people",
  purchase: "purchases",
  payment: "payments",
  refund: "refunds",
  payout: "payouts",
} as const;

function applyOperation(before: Records, op: Operation): Records {
  if (op.recordType === "settings") {
    switch (op.kind) {
      case "create":
        return { ...before, settings: { ...op.record, version: op.id } as Records["settings"] };
      case "update":
        return before.settings?.id === op.recordId
          ? { ...before, settings: { ...before.settings, ...op.patch, version: op.id } }
          : before;
      case "delete":
        return before.settings?.id === op.recordId ? { ...before, settings: null } : before;
    }
  }

  const collection = collectionByType[op.recordType];
  const rows = before[collection];
  switch (op.kind) {
    case "create":
      return { ...before, [collection]: [...rows, { ...op.record, version: op.id }] };
    case "update":
      return {
        ...before,
        [collection]: rows.map(row => row.id === op.recordId ? { ...row, ...op.patch, version: op.id } : row),
      };
    case "delete":
      return { ...before, [collection]: rows.filter(row => row.id !== op.recordId) };
  }
}

export function calculate(input: LedgerCase): Result {
  const { today, timeZone } = input;
  const records: Records = {
    ...input.records,
    settings: { id: SETTINGS_ID, currency: "TRY", timeZone, version: "fixture" },
  };

  const { balances } = computeLedger(records, today);
  return {
    schedules: Object.fromEntries(records.purchases.map(purchase => [
      purchase.id, { base: buildSchedule(purchase), adjusted: adjustedSchedule(purchase, records.refunds) },
    ])),
    people: Object.fromEntries(Object.entries(balances).map(([id, balance]) => {
      const { personId, paymentsReceived, cashReturned, netReceipts, credit, cashShortfall } = balance;
      return [id, { personId, paymentsReceived, cashReturned, netReceipts, credit, cashShortfall }];
    })),
    valid: validateRecords(records, today)?.code ?? null,
    changes: input.changes.map(({ op }) => {
      const after = applyOperation(records, op);
      return {
        code: validateChange(records, after, op, today)?.code ?? null,
        recordsCode: validateRecords(after, today)?.code ?? null,
      };
    }),
    amounts: input.amounts.map(input => {
      const result = parseAmount(input);
      return result.ok ? result.minor : null;
    }),
  };
}
