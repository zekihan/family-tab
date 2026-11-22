import type {
  LedgerRecord, Operation, Receipt, RecordByType, Records, RecordType, UnappliedOperation,
} from "../types.ts";
import type { RuleError } from "../ledger/index.ts";

export const emptyRecords: Records = {
  settings: null, people: [], purchases: [], payments: [], refunds: [], payouts: [],
};

const collections = {
  person: "people", purchase: "purchases", payment: "payments", refund: "refunds", payout: "payouts",
} as const;

export function findRecord<T extends RecordType>(records: Records, type: T, id: string): RecordByType[T] | null {
  const record = type === "settings"
    ? records.settings
    : records[collections[type as Exclude<RecordType, "settings">]].find(row => row.id === id);
  return (record ?? null) as RecordByType[T] | null;
}

export function patchFields(type: RecordType, fields: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
    value !== undefined && key !== "id" && key !== "version" && !(type === "refund" && key === "purchaseId") &&
    !(type === "settings" && key === "currency")));
}

export function proposedRecord(current: LedgerRecord | null, op: Operation): LedgerRecord | null {
  if (op.kind === "create") return { ...op.record, id: op.recordId, version: op.id } as LedgerRecord;
  if (op.kind === "update" && current) {
    return { ...current, ...patchFields(op.recordType, op.patch), version: op.id };
  }
  return null;
}

export function applyOperation(records: Records, op: Operation): Records {
  const current = findRecord(records, op.recordType, op.recordId);
  if (op.kind === "create" && current) return records;
  if (op.kind !== "create" && !current) return records;
  if (op.kind === "delete" && op.recordType === "settings") return records;
  const next = proposedRecord(current, op);
  if (op.recordType === "settings") return { ...records, settings: next as Records["settings"] };
  const key = collections[op.recordType];
  const rows: LedgerRecord[] = records[key];
  const updated = current
    ? rows.flatMap(row => row.id !== op.recordId ? [row] : next ? [next] : [])
    : [...rows, next];
  return { ...records, [key]: updated };
}

type QueueState =
  | { state: "sendable" }
  | { state: "pendingUndo"; deadline: number }
  | { state: "acked"; receipt: Receipt }
  | { state: "needsReview"; reason: string; receipt?: Receipt; restore?: boolean; ruleError?: RuleError };

export type QueueEntry = QueueState & {
  order: number;
  op: Operation;
  people: string[];
  local: LedgerRecord | null;
  dependencies?: string[];
};

export function affectedPeople(records: Records, op: Operation): string[] {
  if (op.recordType === "person") {
    return op.kind !== "update" || "archived" in op.patch ? [op.recordId] : [];
  }
  const current = findRecord(records, op.recordType, op.recordId);
  const changes = op.kind === "create" ? op.record : op.kind === "update" ? op.patch : op.preImage;
  const people = new Set<string>();
  for (const record of [current, changes]) {
    if (!record) continue;
    if ("personId" in record && typeof record.personId === "string") people.add(record.personId);
    if ("purchaseId" in record && typeof record.purchaseId === "string") {
      const purchase = findRecord(records, "purchase", record.purchaseId);
      if (purchase) people.add(purchase.personId);
    }
  }
  return [...people];
}

export function related(earlier: QueueEntry, later: QueueEntry): boolean {
  if (later.dependencies?.includes(earlier.op.id)) return true;
  if (earlier.op.recordId === later.op.recordId && earlier.op.recordType === later.op.recordType) return true;
  const a = earlier.op;
  const b = later.op;
  if (a.recordType === "settings" || b.recordType === "settings") {
    return (a.recordType === "settings" && b.recordType === "settings") ||
      (a.recordType === "settings" && a.kind === "create");
  }
  // A refund also depends on an operation on its purchase even if it has no current owner.
  const purchaseId = (entry: QueueEntry) => {
    const payload = entry.local ?? (entry.op.kind === "delete" ? entry.op.preImage : null);
    return entry.op.recordType === "refund" && payload && "purchaseId" in payload ? payload.purchaseId : null;
  };
  if (a.recordType === "purchase" && purchaseId(later) === a.recordId) return true;
  if (b.recordType === "purchase" && purchaseId(earlier) === b.recordId) return true;
  return earlier.people.some(person => later.people.includes(person));
}

export function replay(
  snapshot: Records, queue: QueueEntry[], now: number,
  validate?: (before: Records, after: Records, row: QueueEntry) => RuleError | null,
) {
  let records = snapshot;
  let context = snapshot;
  const excluded: QueueEntry[] = [];
  const held: QueueEntry[] = [];
  const earlierRows: QueueEntry[] = [];
  const items: { op: Operation; deps: string[] }[] = [];
  const sent: QueueEntry[] = [];
  const waiting = new Map<string, string[]>();
  const reviewWaiting = new Set<string>();

  for (const entry of queue) {
    const op = entry.op;
    const row = {
      ...entry,
      people: [...new Set([...entry.people, ...affectedPeople(context, op)])],
    };
    context = applyOperation(context, op);
    if (row.state === "needsReview" && earlierRows.some(earlier => related(earlier, row))) {
      reviewWaiting.add(op.id);
    }
    earlierRows.push(row);
    const review = excluded.filter(earlier => related(earlier, row));
    if (review.length) waiting.set(op.id, review.map(earlier => earlier.op.id));
    if (row.state === "needsReview" || review.length) {
      excluded.push(row);
      continue;
    }
    const after = applyOperation(records, op);
    const error = row.state === "acked" ? null : validate?.(records, after, row);
    if (error) {
      excluded.push({ ...row, state: "needsReview", reason: error.reason, ruleError: error });
      continue;
    }
    records = after;
    if ((row.state === "pendingUndo" && row.deadline > now) || held.some(earlier => related(earlier, row))) {
      held.push(row);
    } else if (row.state === "sendable" || row.state === "pendingUndo") {
      items.push({ op, deps: sent.filter(earlier => related(earlier, row)).map(earlier => earlier.op.id) });
      sent.push(row);
    }
  }
  return { records, excluded, waiting, reviewWaiting, items };
}

export function reflects(records: Records, op: Operation): boolean {
  const record = findRecord(records, op.recordType, op.recordId);
  if (op.kind === "delete") return record === null;
  if (!record) return false;
  const { version: _version, ...content } = record;
  const intended = op.kind === "create" ? op.record : patchFields(op.recordType, op.patch);
  const fields = Object.entries(intended).filter(([key]) => key !== "version");
  return (op.kind !== "create" || fields.length === Object.keys(content).length) &&
    fields.every(([key, value]) => Object.hasOwn(content, key) && (content as Record<string, unknown>)[key] === value);
}

export function unappliedOperations(excluded: QueueEntry[], waiting: Map<string, string[]>): UnappliedOperation[] {
  return excluded.map(row => ({
    order: row.order, op: row.op, dependencies: waiting.get(row.op.id) ?? [],
    reason: row.state === "needsReview" ? row.reason : null,
  }));
}
