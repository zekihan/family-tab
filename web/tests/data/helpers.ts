import type { FamilyTabStore, StoreOptions } from "../../src/data/index.ts";
import { createStore } from "../../src/data/index.ts";
import { applyOperation, emptyRecords } from "../../src/data/model.ts";
import type { BackupFile, Person, Purchase, Refund, Payment, Snapshot, Receipt, Operation, OpResult, RestoreRequest } from "../../src/types.ts";

export const person: Person = { id: "00000000-0000-4000-8000-000000000001", version: "initial-a", name: "A", archived: false, payday: null };
export const other: Person = { ...person, id: "00000000-0000-4000-8000-000000000002", version: "initial-b", name: "B" };
export const purchase: Purchase = {
  id: "00000000-0000-4000-8000-000000000003", version: "initial-purchase", personId: person.id, item: "Item", totalMinor: 100,
  boughtOn: "2026-11-22", plan: "once", dueDate: null, count: null, firstDue: null, dueDay: null, note: null,
};
export const refund: Refund = {
  id: "00000000-0000-4000-8000-000000000004", version: "initial-refund", purchaseId: purchase.id,
  amountMinor: 10, refundedOn: "2026-11-22", note: null,
};
export const payment = (personId = person.id): Omit<Payment, "id" | "version"> => ({
  personId, amountMinor: 100, paidOn: "2026-11-22", note: null,
});
export function initial(): Snapshot {
  return {
    ...emptyRecords,
    settings: { id: "ledger", version: "setup", currency: "TRY", timeZone: "UTC" },
    generation: "generation-1", revision: 3, people: [person, other], purchases: [purchase], refunds: [refund],
  };
}
export function backup(unapplied: BackupFile["unapplied"] = []): BackupFile {
  const { people, purchases, payments, refunds, payouts } = initial();
  return {
    format: "family-tab-backup", formatVersion: 1, currency: "TRY", timeZone: "UTC",
    exportedAt: "2026-11-22T00:00:00Z", people, purchases, payments, refunds, payouts, unapplied,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export function fakeServer() {
  let snapshot = initial();
  const receipts = new Map<string, Receipt>();
  const calls: { path: string; body: unknown }[] = [];
  const operations: { items: { op: Operation; deps: string[] }[] }[] = [];
  let session: string | null = "buyer";
  const result: { decide?: (op: Operation) => Partial<Receipt> | undefined } = {};
  const hook: { fetch?: (path: string) => Promise<Response | undefined> } = {};
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const hooked = await hook.fetch?.(path);
    if (hooked) return hooked;
    if (path === "/api/logout") {
      session = null;
      return new Response(null, { status: 204 });
    }
    if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });
    if (path === "/api/me") return Response.json({ subject: session, name: null, email: null });
    if (path === "/api/snapshot") return Response.json(snapshot);
    if (path === "/api/sync/receipts") {
      return Response.json({ generation: snapshot.generation, receipts: body.opIds.flatMap((id: string) =>
        receipts.has(id) ? [receipts.get(id)] : []) });
    }
    if (path === "/api/restore") {
      const { backup, opId, expectedRevision } = body as RestoreRequest;
      if (expectedRevision !== snapshot.revision) return Response.json({ status: "rejected", reason: "Stale revision." });
      snapshot = {
        ...snapshot,
        settings: { id: "ledger", currency: "TRY", timeZone: backup.timeZone, version: opId },
        people: backup.people, purchases: backup.purchases, payments: backup.payments,
        refunds: backup.refunds, payouts: backup.payouts,
        revision: expectedRevision + 1, generation: opId,
      };
      const receipt: Receipt = { opId, status: "applied", code: null, reason: null,
        current: null, blocking: [], generation: snapshot.generation, revision: snapshot.revision };
      receipts.set(opId, receipt);
      return Response.json(receipt);
    }
    if (path !== "/api/sync/ops") throw new Error(`Unexpected API request ${path}`);
    operations.push(body);
    const results: OpResult[] = [];
    for (const { op, deps } of operations.at(-1)!.items) {
      const stored = receipts.get(op.id);
      if (stored) { results.push(stored); continue; }
      if (deps.some(id => receipts.get(id)?.status !== "applied")) {
        results.push({ opId: op.id, status: "skipped", code: "dependency_not_applied" });
        continue;
      }
      if (op.generation !== snapshot.generation) {
        results.push({ opId: op.id, status: "held", code: "generation_mismatch", generation: snapshot.generation });
        continue;
      }
      const decision = result.decide?.(op);
      if (!decision || decision.status === "applied") {
        snapshot = { ...snapshot, ...applyOperation(snapshot, op), revision: snapshot.revision + 1 };
      }
      const receipt: Receipt = {
        opId: op.id, status: "applied", code: null, reason: null, blocking: [], current: null,
        generation: snapshot.generation, revision: snapshot.revision, ...decision,
      };
      receipts.set(op.id, receipt);
      results.push(receipt);
    }
    return Response.json({ generation: snapshot.generation, results });
  };
  return {
    fetch, calls, receipts, operations, result, hook, get snapshot() { return snapshot; },
    replace: (value: Snapshot) => { snapshot = value; },
    signIn: (subject: string | null) => { session = subject; },
  };
}

export function harness(overrides: StoreOptions = {}) {
  const server = fakeServer();
  const clock = { now: Date.parse("2026-11-22T12:00:00Z"), online: true };
  const rules: NonNullable<StoreOptions["rules"]> = {
    todayIn: () => "2026-11-22",
    computeLedger: (_records, today) => ({
      today, balances: {}, chips: {}, purchases: {}, comingUp: [], homeOrder: [],
      home: { leftToPay: 0, dueByToday: 0, dueNextMonth: 0, archivedLeftToPay: 0, credit: 0 },
    }),
    validateRecords: () => null,
    validateChange: () => null,
  };
  const dbName = crypto.randomUUID();
  const options: StoreOptions = {
    dbName, now: () => clock.now, online: () => clock.online, fetch: server.fetch,
    rules, automatic: false, ...overrides,
  };
  const store = createStore(options);
  return { store, createAnother: () => createStore(options), server, clock, rules, dbName };
}

export function token(store: FamilyTabStore, record: { version: string }) {
  return { generation: store.getSnapshot().generation!, version: record.version };
}
