import type { OpResult, Receipt, Records, Snapshot } from "../types.ts";
import type { Api } from "./api.ts";
import { changeLocal, LocalStateError, readLocal } from "./db.ts";
import type { LedgerDB, LocalState } from "./db.ts";
import { affectedPeople, applyOperation, emptyRecords, findRecord, reflects, replay } from "./model.ts";
import type { QueueEntry } from "./model.ts";

export function assertSession(state: LocalState, epoch: string | undefined) {
  if (state.meta.signedOut || state.meta.epoch !== epoch) throw new LocalStateError("signedOut");
}

function restoreReview(row: QueueEntry): Extract<QueueEntry, { state: "needsReview" }> {
  if (row.state === "needsReview" && row.restore) return row;
  return { ...row, state: "needsReview", restore: true, receipt: undefined,
    reason: "The ledger was restored. Review this change against the restored ledger." };
}

function observeResults(state: LocalState, generation: string, results: OpResult[]) {
  const byId = new Map(results.map(result => [result.opId, result]));
  state.queue = state.queue.map(row => {
    const result = byId.get(row.op.id);
    // Preserve the intended record and the original operation while the ledger changes.
    if (row.op.generation !== generation || (result && "generation" in result && result.generation !== generation) ||
        (row.state === "acked" && row.receipt.generation !== generation)) return restoreReview(row);
    if (!result || result.status === "skipped" || (row.state === "needsReview" && row.restore)) return row;
    if (result.status === "held") return restoreReview(row);
    if (result.status === "applied") return { ...row, state: "acked", receipt: result };
    return { ...row, state: "needsReview", receipt: result, reason: result.reason ?? "The server declined this change." };
  });
}

export function reconcile(state: LocalState, snapshot: Snapshot, now: number) {
  state.queue = state.queue.flatMap(row => {
    if (row.op.generation !== snapshot.generation ||
      (row.state === "acked" && row.receipt.generation !== snapshot.generation)) {
      return reflects(snapshot, row.op) ? [] : [restoreReview(row)];
    }
    if (row.state === "acked" && row.receipt.revision <= snapshot.revision) return [];
    return [row];
  });
  state.snapshot = snapshot;
  state.meta.lastSyncAt = now;
}

function isAhead(receipts: Receipt[], snapshot: Snapshot) {
  return receipts.some(receipt => receipt.generation === snapshot.generation && receipt.revision > snapshot.revision);
}

/** A cycle runs inside the device lock. Each local commit checks its original session. */
export async function syncLedger(
  db: LedgerDB, api: Api, epoch: string | undefined, now: () => number, publish: () => Promise<void>,
) {
  let state = await readLocal(db);
  assertSession(state, epoch);
  const checked = new Set(state.queue.map(row => row.op.id));
  const { generation, receipts } = await api.receipts([...checked]);
  const items = await changeLocal(db, epoch, current => {
    observeResults(current, generation, receipts);
    const selected = new Set<string>();
    return replay(current.snapshot ?? emptyRecords, current.queue, now()).items.filter(item => {
      if (!checked.has(item.op.id) || !item.deps.every(dep => selected.has(dep))) return false;
      selected.add(item.op.id);
      return true;
    });
  });
  await publish();
  const receiptList = [...receipts];
  if (items.length) {
    assertSession(await readLocal(db), epoch);
    const result = await api.ops({ items });
    await changeLocal(db, epoch, current => observeResults(current, result.generation, result.results));
    receiptList.push(...result.results.filter((row): row is Receipt => "revision" in row));
    await publish();
  }

  for (;;) {
    state = await readLocal(db);
    assertSession(state, epoch);
    const snapshot = await api.snapshot();
    const seen = state.queue.flatMap(row => row.state === "acked" ? [row.receipt] : []);
    if (isAhead([...receiptList, ...seen], snapshot) ||
      (state.snapshot?.generation === snapshot.generation && state.snapshot.revision > snapshot.revision)) continue;
    await changeLocal(db, epoch, current => reconcile(current, snapshot, now()));
    return;
  }
}

export function importUnapplied(state: LocalState, snapshot: Snapshot, now: number) {
  const unapplied = state.meta.restore?.request.backup.unapplied ?? [];
  let context: Records = snapshot;
  const known = new Set(state.queue.map(row => row.op.id));
  const imported: QueueEntry[] = [];
  for (const row of [...unapplied].sort((a, b) => a.order - b.order)) {
    const op = row.op;
    if (known.has(op.id) || reflects(snapshot, op)) continue;
    const before = context;
    context = applyOperation(context, op);
    const intended = findRecord(context, op.recordType, op.recordId);
    const local = op.kind === "update" && intended?.version !== op.id ? null : intended;
    imported.push({
      ...restoreReview({ op, order: row.order, state: "sendable",
        local, people: affectedPeople(before, op), dependencies: row.dependencies }),
      reason: row.reason ?? "This change was unapplied in the restored backup.",
    });
    known.add(op.id);
  }
  const lastImported = imported.at(-1)?.order ?? 0;
  const firstExisting = state.queue[0]?.order ?? 0;
  const offset = Math.max(0, lastImported + 1 - firstExisting);
  state.queue = [...imported, ...state.queue.map(row => offset && imported.length ? { ...row, order: row.order + offset } : row)];
  reconcile(state, snapshot, now);
  delete state.meta.restore;
}
