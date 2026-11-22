import { isValidDate } from "../ledger/index.ts";
import type { BackupFile, LedgerRecord, Operation, Records, RecordType } from "../types.ts";

export const recordCollections = ["people", "purchases", "payments", "refunds", "payouts"] as const;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

type FieldType = "string" | "number" | "boolean" | "string?" | "number?";

function validField(value: unknown, type: FieldType): boolean {
  if (type === "number" || type === "number?") {
    return (type === "number?" && value === null) || Number.isSafeInteger(value);
  }
  if (type === "string?") return value === null || typeof value === "string";
  return typeof value === type;
}

function onlyFields(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function isUUIDv4(value: string): boolean {
  return value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && value === value.trim() &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|\+00:00)$/.test(value) &&
    isValidDate(value.slice(0, 10));
}

function backupRecord(
  row: unknown, fields: Record<string, FieldType>, version: "optional" | "required" | "absent",
): row is { id: string; version?: string } {
  return object(row) && typeof row.id === "string" &&
    onlyFields(row, ["id", ...Object.keys(fields), ...(version === "absent" ? [] : ["version"])]) &&
    (version === "absent" || typeof row.version === "string" ||
      (version === "optional" && !Object.hasOwn(row, "version"))) &&
    Object.entries(fields).every(([key, type]) => validField(row[key], type));
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

const operationFields = ["id", "generation", "createdAt", "recordType", "recordId", "kind"];

export function validPatch(type: RecordType, patch: unknown): boolean {
  if (!object(patch)) return false;
  const fields: Record<string, FieldType> = types[type];
  return Object.entries(patch).every(([key, value]) =>
    Object.hasOwn(fields, key) && !(type === "refund" && key === "purchaseId") &&
    !(type === "settings" && key === "currency") && validField(value, fields[key]));
}

function validateBackupOperation(op: unknown, error: (reason: string) => never): asserts op is Operation {
  if (!object(op) || typeof op.id !== "string" || !isUUIDv4(op.id) ||
      typeof op.recordId !== "string" || typeof op.generation !== "string" || !op.generation ||
      !validTimestamp(op.createdAt) || typeof op.recordType !== "string" ||
      !Object.hasOwn(types, op.recordType)) error("invalid operation metadata.");
  const type = op.recordType as RecordType;
  if (type === "settings" ? op.recordId !== "ledger" : !isUUIDv4(op.recordId as string)) {
    error("invalid recordId.");
  }
  const allowed = type === "payout" ? [...operationFields, "alreadyReturned"] : operationFields;
  if (Object.hasOwn(op, "alreadyReturned") && (type !== "payout" || typeof op.alreadyReturned !== "boolean")) {
    error("alreadyReturned must be a boolean on a payout.");
  }
  const fields = types[type];
  switch (op.kind) {
    case "create":
      if (!onlyFields(op, [...allowed, "record"]) || !backupRecord(op.record, fields, "absent") ||
          op.record.id !== op.recordId) error("invalid create record.");
      break;
    case "update":
      if (!onlyFields(op, [...allowed, "baseVersion", "patch"]) ||
          typeof op.baseVersion !== "string" || !op.baseVersion || !validPatch(type, op.patch)) {
        error("invalid update patch or baseVersion.");
      }
      break;
    case "delete":
      if (!onlyFields(op, [...allowed, "baseVersion", "preImage"]) || type === "settings" ||
          typeof op.baseVersion !== "string" || !op.baseVersion || !backupRecord(op.preImage, fields, "required") ||
          op.preImage.id !== op.recordId ||
          op.preImage.version !== op.baseVersion) error("invalid delete preImage or baseVersion.");
      break;
    default: error("invalid operation kind.");
  }
}

function validateUnapplied(rows: unknown[]) {
  const orders = new Map<string, number>();
  const dependencies = Array.from(rows, (row, index) => {
    const error = (reason: string): never => { throw new Error(`Invalid unapplied operation ${index + 1}: ${reason}`); };
    if (!object(row) || !onlyFields(row, ["order", "dependencies", "reason", "op"]) ||
        typeof row.order !== "number" || !Number.isSafeInteger(row.order) || row.order < 0 ||
        !Array.isArray(row.dependencies) || (row.reason !== null && typeof row.reason !== "string")) {
      return error("expected an integer order, a dependency array and a string or null reason.");
    }
    validateBackupOperation(row.op, error);
    if (orders.has(row.op.id)) error("duplicate operation ID.");
    orders.set(row.op.id, row.order);
    return { order: row.order, ids: row.dependencies, error };
  });
  for (const { order, ids, error } of dependencies) {
    for (const id of ids) {
      const earlier = typeof id === "string" ? orders.get(id) : undefined;
      if (earlier === undefined || earlier >= order) error("dependencies must reference earlier unapplied operations.");
    }
  }
}

export function parseBackup(input: unknown): BackupFile {
  const file: unknown = typeof input === "string" ? JSON.parse(input) : structuredClone(input);
  if (!object(file) || !onlyFields(file, ["format", "formatVersion", "exportedAt", "currency", "timeZone",
    ...recordCollections, "unapplied"]) || file.format !== "family-tab-backup" || file.formatVersion !== 1 ||
      file.currency !== "TRY" || typeof file.timeZone !== "string" || !validTimestamp(file.exportedAt) ||
      !Array.isArray(file.unapplied)) {
    throw new Error("Invalid Family Tab backup file.");
  }
  for (const key of recordCollections) {
    const rows = file[key];
    if (!Array.isArray(rows) || !Array.from(rows).every(row => backupRecord(row, recordFields[key], "optional") &&
      isUUIDv4(row.id))) throw new Error(`Invalid backup records in ${key}.`);
  }
  validateUnapplied(file.unapplied);
  return file as unknown as BackupFile;
}

export function reviewRecord(type: RecordType, record: LedgerRecord | null): LedgerRecord | null {
  return backupRecord(record, types[type], "required") ? record : null;
}

// Older imports could include extra fields. Keep them out of record summaries
// where a stray field could make the UI treat the payload as another record type.
export function reviewOperation(op: Operation): Operation {
  const project = <T extends object>(record: T): T => Object.fromEntries(Object.entries(record).filter(([key]) =>
    key === "id" || key === "version" || Object.hasOwn(types[op.recordType], key))) as T;
  if (op.kind === "create") return { ...op, record: project(op.record) };
  if (op.kind === "delete") return { ...op, preImage: project(op.preImage) };
  return op;
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
