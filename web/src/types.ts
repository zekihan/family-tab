// Wire and record types shared by the ledger module, the data layer and the
// UI. They mirror internal/ledger/types.go and internal/protocol/protocol.go;
// docs/PROTOCOL.md is the contract.

export type DateString = string; // YYYY-MM-DD

export const SETTINGS_ID = "ledger";
export const HEADER_NAME = "X-Family-Tab";
export const HEADER_VALUE = "1";

export interface Settings {
  id: typeof SETTINGS_ID;
  timeZone: string;
  currency: "TRY";
  version: string;
}

export interface Person {
  id: string;
  name: string;
  aliases: string[];
  payday: number | null;
  archived: boolean;
  version: string;
}

export type Plan = "once" | "installments";

/** Who created a purchase, payment or refund. Set by the server on create. */
export type RecordSource = "app" | "agent";

export interface Purchase {
  id: string;
  personId: string;
  item: string;
  totalMinor: number;
  boughtOn: DateString;
  plan: Plan;
  dueDate: DateString | null;
  count: number | null;
  firstDue: DateString | null;
  dueDay: number | null;
  note: string | null;
  source: RecordSource;
  version: string;
}

export interface Payment {
  id: string;
  personId: string;
  amountMinor: number;
  paidOn: DateString;
  note: string | null;
  source: RecordSource;
  version: string;
}

export interface Refund {
  id: string;
  purchaseId: string;
  amountMinor: number;
  refundedOn: DateString;
  note: string | null;
  source: RecordSource;
  version: string;
}

export interface Payout {
  id: string;
  personId: string;
  amountMinor: number;
  paidOutOn: DateString;
  note: string | null;
  version: string;
}

export interface Records {
  settings: Settings | null;
  people: Person[];
  purchases: Purchase[];
  payments: Payment[];
  refunds: Refund[];
  payouts: Payout[];
}

export type LedgerRecord = Settings | Person | Purchase | Payment | Refund | Payout;

export type RecordType = "settings" | "person" | "purchase" | "payment" | "refund" | "payout";

export interface RecordByType {
  settings: Settings;
  person: Person;
  purchase: Purchase;
  payment: Payment;
  refund: Refund;
  payout: Payout;
}

/** Client-supplied fields of a record, without its id, version or server-set source. */
export type RecordFields<T extends RecordType> = Omit<RecordByType[T], "id" | "version" | "source">;

// Omit on a union keeps only keys shared by every member. Distribute so each
// record keeps its own fields (docs/PROTOCOL.md sections 2 and 3).
type EachOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** create.record: the full record without version, and without source. */
export type RecordWithoutVersion = EachOmit<LedgerRecord, "version" | "source">;

type NotPatchable<T extends RecordType> =
  | "id"
  | "version"
  | "source"
  | (T extends "refund" ? "purchaseId" : never)
  | (T extends "settings" ? "currency" : never);

/** update.patch: changed fields only. id, version, source, refund.purchaseId and settings.currency are not patchable. */
export type RecordPatch = {
  [T in RecordType]: Partial<Omit<RecordByType[T], NotPatchable<T>>>
}[RecordType];

interface OperationBase {
  id: string;
  generation: string;
  createdAt: string;
  recordType: RecordType;
  recordId: string;
  alreadyReturned?: boolean;
}

export type CreateOperation = OperationBase & {
  kind: "create";
  record: RecordWithoutVersion;
};

export type UpdateOperation = OperationBase & {
  kind: "update";
  baseVersion: string;
  patch: RecordPatch;
};

export type DeleteOperation = OperationBase & {
  kind: "delete";
  baseVersion: string;
  preImage: LedgerRecord;
};

export type Operation = CreateOperation | UpdateOperation | DeleteOperation;

export type ReceiptCode =
  | "conflict"
  | "not_found"
  | "duplicate_id"
  | "invalid"
  | "refunds_exceed_total"
  | "archived_person"
  | "purchase_has_refunds"
  | "person_has_records"
  | "payout_exceeds_credit"
  | "not_setup"
  | "alias_conflict";

export interface Receipt {
  opId: string;
  status: "applied" | "rejected" | "conflict";
  code: ReceiptCode | null;
  reason: string | null;
  blocking: string[];
  current: LedgerRecord | null;
  generation: string;
  revision: number;
}

export type OpResult =
  | Receipt
  | { opId: string; status: "held"; code: "generation_mismatch"; generation: string }
  | { opId: string; status: "skipped"; code: "dependency_not_applied" };

export interface Snapshot extends Records {
  generation: string;
  revision: number;
}

export interface ReceiptsResponse {
  generation: string;
  receipts: Receipt[];
}

export interface OpsRequest {
  items: { op: Operation; deps: string[] }[];
}

export interface OpsResponse {
  generation: string;
  results: OpResult[];
}

export interface UnappliedOperation {
  order: number;
  op: Operation;
  dependencies: string[];
  reason: string | null;
}

export interface BackupFile {
  format: "family-tab-backup";
  formatVersion: 1;
  exportedAt: string;
  currency: "TRY";
  timeZone: string;
  people: Person[];
  purchases: Purchase[];
  payments: Payment[];
  refunds: Refund[];
  payouts: Payout[];
  unapplied: UnappliedOperation[];
}

export interface RestoreRequest {
  opId: string;
  expectedRevision: number;
  backup: BackupFile;
}

export interface RestoreResult {
  opId: string;
  status: "applied" | "rejected";
  code: null | "invalid" | "revision_mismatch";
  reason: string | null;
  generation: string;
  revision: number;
}

export interface Me {
  subject: string;
  name: string | null;
  email: string | null;
}

// Derived figures (DESIGN.md section 5). Produced by src/ledger.

export interface ScheduledAmount {
  purchaseId: string;
  sequence: number;
  baseMinor: number;
  adjustedMinor: number;
  dueOn: DateString | null;
}

export interface PersonBalance {
  personId: string;
  leftToPay: number;
  dueByToday: number;
  dueNextMonth: number;
  behindPlan: boolean;
  paymentsReceived: number;
  cashReturned: number;
  netReceipts: number;
  credit: number;
  cashShortfall: number;
  earliestUnpaidFuture: DateString | null;
}

export interface HomeTotals {
  leftToPay: number;
  dueByToday: number;
  dueNextMonth: number;
  credit: number;
  archivedLeftToPay: number;
}

export interface ComingUpEntry {
  personId: string;
  purchaseId: string;
  sequence: number;
  dueOn: DateString;
  remainingMinor: number;
  archived: boolean;
}

export type StatusChip =
  | { kind: "credit"; amountMinor: number; behindPlan: false }
  | { kind: "allPaid"; behindPlan: false }
  | { kind: "dueByToday"; amountMinor: number; behindPlan: boolean }
  | { kind: "nextDate"; date: DateString; behindPlan: boolean }
  | { kind: "whenTheyCan"; behindPlan: boolean };

export interface PaymentChip {
  kind: "dueByToday" | "throughNextDue" | "everything";
  amountMinor: number;
  shortfallMinor: number;
}
