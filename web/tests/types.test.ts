import assert from "node:assert/strict";
import { test } from "node:test";
import { HEADER_NAME, HEADER_VALUE, SETTINGS_ID } from "../src/types.ts";
import type {
  BackupFile, ComingUpEntry, CreateOperation, DateString, DeleteOperation, HomeTotals, Me, Operation, OpResult,
  Payment, PaymentChip, Payout, Person, PersonBalance, Purchase, Receipt, ReceiptCode, ReceiptsResponse, Records,
  RecordType, Refund, RestoreRequest, RestoreResult, ScheduledAmount, Settings, Snapshot, StatusChip,
  UnappliedOperation, UpdateOperation,
} from "../src/types.ts";

// Mutual assignability. A failing call is a field-level drift from docs/PROTOCOL.md.
function assertType<T extends true>(value: T) {
  void value;
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type Source = "app" | "agent";
type ProtocolSettings = { id: "ledger"; timeZone: string; currency: "TRY"; version: string };
type ProtocolPerson = { id: string; name: string; payday: number | null; aliases: string[]; archived: boolean; version: string };
type ProtocolPurchase = {
  id: string; personId: string; item: string; totalMinor: number; boughtOn: DateString;
  plan: "once" | "installments";
  dueDate: DateString | null; count: number | null; firstDue: DateString | null; dueDay: number | null;
  note: string | null; source: Source; version: string;
};
type ProtocolPayment = { id: string; personId: string; amountMinor: number; paidOn: DateString; note: string | null; source: Source; version: string };
type ProtocolRefund = { id: string; purchaseId: string; amountMinor: number; refundedOn: DateString; note: string | null; source: Source; version: string };
type ProtocolPayout = { id: string; personId: string; amountMinor: number; paidOutOn: DateString; note: string | null; version: string };
type ProtocolRecord = ProtocolSettings | ProtocolPerson | ProtocolPurchase | ProtocolPayment | ProtocolRefund | ProtocolPayout;
type ProtocolRecords = {
  settings: ProtocolSettings | null;
  people: ProtocolPerson[]; purchases: ProtocolPurchase[]; payments: ProtocolPayment[];
  refunds: ProtocolRefund[]; payouts: ProtocolPayout[];
};
type ProtocolCreateRecord =
  | Omit<ProtocolSettings, "version">
  | Omit<ProtocolPerson, "version">
  | Omit<ProtocolPurchase, "version" | "source">
  | Omit<ProtocolPayment, "version" | "source">
  | Omit<ProtocolRefund, "version" | "source">
  | Omit<ProtocolPayout, "version">;
type ProtocolPatch =
  | Partial<Omit<ProtocolSettings, "id" | "version" | "currency">>
  | Partial<Omit<ProtocolPerson, "id" | "version">>
  | Partial<Omit<ProtocolPurchase, "id" | "version" | "source">>
  | Partial<Omit<ProtocolPayment, "id" | "version" | "source">>
  | Partial<Omit<ProtocolRefund, "id" | "version" | "source" | "purchaseId">>
  | Partial<Omit<ProtocolPayout, "id" | "version">>;
type ProtocolOperationBase = {
  id: string; generation: string; createdAt: string; recordType: RecordType; recordId: string;
  alreadyReturned?: boolean;
};
type ProtocolOperation =
  | (ProtocolOperationBase & { kind: "create"; record: ProtocolCreateRecord })
  | (ProtocolOperationBase & { kind: "update"; baseVersion: string; patch: ProtocolPatch })
  | (ProtocolOperationBase & { kind: "delete"; baseVersion: string; preImage: ProtocolRecord });
type ProtocolReceiptCode =
  | "conflict" | "not_found" | "duplicate_id" | "operation_id_conflict" | "invalid" | "refunds_exceed_total" | "archived_person"
  | "purchase_has_refunds" | "person_has_records" | "alias_conflict" | "payout_exceeds_credit" | "not_setup";
type ProtocolReceipt = {
  opId: string; status: "applied" | "rejected" | "conflict"; code: ProtocolReceiptCode | null; reason: string | null;
  blocking: string[]; current: ProtocolRecord | null; generation: string; revision: number;
  restore?: true;
};
type ProtocolOpResult =
  | ProtocolReceipt
  | { opId: string; status: "held"; code: "generation_mismatch"; generation: string }
  | { opId: string; status: "skipped"; code: "dependency_not_applied" };
interface ProtocolSnapshot extends ProtocolRecords { generation: string; revision: number }
type ProtocolBackup = {
  format: "family-tab-backup"; formatVersion: 1; exportedAt: string; currency: "TRY"; timeZone: string;
  people: ProtocolPerson[]; purchases: ProtocolPurchase[]; payments: ProtocolPayment[];
  refunds: ProtocolRefund[]; payouts: ProtocolPayout[];
  unapplied: { order: number; op: ProtocolOperation; dependencies: string[]; reason: string | null }[];
};

test("wire types match docs/PROTOCOL.md", () => {
  assert.equal(SETTINGS_ID, "ledger");
  assert.equal(HEADER_NAME, "X-Family-Tab");
  assert.equal(HEADER_VALUE, "1");
  assertType<Equal<Settings, ProtocolSettings>>(true);
  assertType<Equal<Person, ProtocolPerson>>(true);
  assertType<Equal<Purchase, ProtocolPurchase>>(true);
  assertType<Equal<Payment, ProtocolPayment>>(true);
  assertType<Equal<Refund, ProtocolRefund>>(true);
  assertType<Equal<Payout, ProtocolPayout>>(true);
  assertType<Equal<Records, ProtocolRecords>>(true);
  assertType<Equal<RecordType, "settings" | "person" | "purchase" | "payment" | "refund" | "payout">>(true);
  assertType<Equal<ReceiptCode, ProtocolReceiptCode>>(true);
  assertType<Equal<CreateOperation["record"], ProtocolCreateRecord>>(true);
  assertType<Equal<UpdateOperation["patch"], ProtocolPatch>>(true);
  assertType<Equal<DeleteOperation["preImage"], ProtocolRecord>>(true);
  assertType<Equal<Operation, ProtocolOperation>>(true);
  assertType<Equal<Receipt, ProtocolReceipt>>(true);
  assertType<Equal<OpResult, ProtocolOpResult>>(true);
  assertType<Equal<Snapshot, ProtocolSnapshot>>(true);
  assertType<Equal<ReceiptsResponse, { generation: string; receipts: ProtocolReceipt[] }>>(true);
  assertType<Equal<BackupFile, ProtocolBackup>>(true);
  assertType<Equal<UnappliedOperation, ProtocolBackup["unapplied"][number]>>(true);
  assertType<Equal<RestoreRequest, { opId: string; expectedRevision: number; backup: ProtocolBackup }>>(true);
  assertType<Equal<RestoreResult, {
    opId: string; status: "applied" | "rejected"; code: null | "invalid" | "revision_mismatch" | "operation_id_conflict";
    reason: string | null; generation: string; revision: number;
  }>>(true);
  assertType<Equal<Me, { subject: string; name: string | null; email: string | null }>>(true);
  assertType<Equal<ScheduledAmount, {
    purchaseId: string; sequence: number; baseMinor: number; adjustedMinor: number; dueOn: DateString | null;
  }>>(true);
  assertType<Equal<PersonBalance, {
    personId: string; leftToPay: number; dueByToday: number; dueNextMonth: number; behindPlan: boolean;
    paymentsReceived: number; cashReturned: number; netReceipts: number; credit: number; cashShortfall: number;
    earliestUnpaidFuture: DateString | null;
  }>>(true);
  assertType<Equal<HomeTotals, {
    leftToPay: number; dueByToday: number; dueNextMonth: number; credit: number; archivedLeftToPay: number;
  }>>(true);
  assertType<Equal<ComingUpEntry, {
    personId: string; purchaseId: string; sequence: number; dueOn: DateString; remainingMinor: number; archived: boolean;
  }>>(true);
  assertType<Equal<StatusChip,
    | { kind: "credit"; amountMinor: number; behindPlan: false }
    | { kind: "allPaid"; behindPlan: false }
    | { kind: "dueByToday"; amountMinor: number; behindPlan: boolean }
    | { kind: "nextDate"; date: DateString; behindPlan: boolean }
    | { kind: "whenTheyCan"; behindPlan: boolean }
  >>(true);
  assertType<Equal<PaymentChip, {
    kind: "dueByToday" | "throughNextDue" | "everything"; amountMinor: number; shortfallMinor: number;
  }>>(true);

  const person: ProtocolCreateRecord = {
    id: "00000000-0000-4000-8000-000000000001", name: "Mom", aliases: [], payday: null, archived: false,
  };
  const created: CreateOperation = {
    id: "00000000-0000-4000-8000-000000000099", generation: "g", createdAt: "2026-11-22T00:00:00Z",
    recordType: "person", recordId: person.id, kind: "create", record: person,
  };
  assert.equal(created.recordType, "person");
});
