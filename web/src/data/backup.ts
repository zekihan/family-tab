import type { BackupFile, LedgerRecord, Records } from "../types.ts";

export const recordCollections = ["people", "purchases", "payments", "refunds", "payouts"] as const;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function backupRecord(row: unknown, fields: Record<string, "string" | "number" | "boolean" | "string?" | "number?">) {
  return object(row) && typeof row.id === "string" &&
    Object.entries(fields).every(([key, type]) =>
      type.endsWith("?") ? row[key] === null || typeof row[key] === type.slice(0, -1) : typeof row[key] === type);
}

const recordFields = {
  people: { name: "string", payday: "number?", archived: "boolean" },
  purchases: { personId: "string", item: "string", totalMinor: "number", boughtOn: "string",
    plan: "string", dueDate: "string?", count: "number?", firstDue: "string?", dueDay: "number?", note: "string?" },
  payments: { personId: "string", amountMinor: "number", paidOn: "string", note: "string?" },
  refunds: { purchaseId: "string", amountMinor: "number", refundedOn: "string", note: "string?" },
  payouts: { personId: "string", amountMinor: "number", paidOutOn: "string", note: "string?" },
} as const;

const types = {
  settings: { timeZone: "string", currency: "string" },
  person: recordFields.people, purchase: recordFields.purchases, payment: recordFields.payments,
  refund: recordFields.refunds, payout: recordFields.payouts,
} as const;

function backupOperation(row: unknown): boolean {
  if (!object(row) || typeof row.order !== "number" || !Number.isSafeInteger(row.order) || row.order < 0 ||
      !Array.isArray(row.dependencies) || !row.dependencies.every(id => typeof id === "string") ||
      (row.reason !== null && typeof row.reason !== "string") || !object(row.op)) return false;
  const op = row.op;
  if (typeof op.id !== "string" || typeof op.recordId !== "string" || typeof op.generation !== "string" ||
      typeof op.createdAt !== "string" || typeof op.recordType !== "string" ||
      !Object.hasOwn(types, op.recordType) ||
      (op.alreadyReturned !== undefined && (op.recordType !== "payout" || typeof op.alreadyReturned !== "boolean"))) return false;
  const fields = types[op.recordType as keyof typeof types];
  if (op.kind === "create") return backupRecord(op.record, fields) && (op.record as LedgerRecord).id === op.recordId;
  if (typeof op.baseVersion !== "string") return false;
  if (op.kind === "update") return object(op.patch);
  return op.kind === "delete" && op.recordType !== "settings" && backupRecord(op.preImage, fields) &&
    (op.preImage as LedgerRecord).id === op.recordId && typeof (op.preImage as LedgerRecord).version === "string";
}

export function parseBackup(input: unknown): BackupFile {
  const file: unknown = typeof input === "string" ? JSON.parse(input) : structuredClone(input);
  if (!object(file) || file.format !== "family-tab-backup" || file.formatVersion !== 1 ||
      file.currency !== "TRY" || typeof file.timeZone !== "string" || typeof file.exportedAt !== "string" ||
      !recordCollections.every(key => {
        const rows = file[key];
        return Array.isArray(rows) && rows.every(row => backupRecord(row, recordFields[key]));
      }) || !Array.isArray(file.unapplied) || !file.unapplied.every(backupOperation)) {
    throw new Error("Invalid Family Tab backup file.");
  }
  return file as unknown as BackupFile;
}

export function backupRecords(file: BackupFile): Records {
  return {
    settings: { id: "ledger", currency: "TRY", timeZone: file.timeZone, version: "" },
    people: file.people, purchases: file.purchases, payments: file.payments, refunds: file.refunds, payouts: file.payouts,
  };
}

export function countRecords(records: Records) {
  return {
    people: records.people.length, purchases: records.purchases.length, payments: records.payments.length,
    refunds: records.refunds.length, payouts: records.payouts.length,
  };
}
