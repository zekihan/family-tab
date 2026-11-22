import type { OpResult, OpsRequest, OpsResponse, Receipt, Records, Snapshot } from "../types.ts";
import type { Api } from "./api.ts";
import { changeLocal, LocalStateError, readLocal } from "./db.ts";
import type { LedgerDB, LocalState } from "./db.ts";
import { affectedPeople, applyOperation, emptyRecords, findRecord, reflects, replay } from "./model.ts";
import type { QueueEntry } from "./model.ts";

const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_ITEMS = 200;
const encoder = new TextEncoder();

export function assertSession(state: LocalState, epoch: string | undefined) {
  if (state.meta.signedOut || state.meta.epoch !== epoch) throw new LocalStateError("signedOut");
}

function restoreReview(row: QueueEntry): Extract<QueueEntry, { state: "needsReview" }> {
  if (row.state === "needsReview" && row.restore) return row;
  return { ...row, state: "needsReview", restore: true, receipt: undefined, ruleError: undefined,
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

function nextBatch(state: LocalState, checked: ReadonlySet<string>, now: number): OpsRequest["items"] {
  const items: OpsRequest["items"] = [];
  const selected = new Set<string>();
  let bytes = '{"items":[]}'.length;
  for (const item of replay(state.snapshot ?? emptyRecords, state.queue, now).items) {
    if (items.length === MAX_BATCH_ITEMS) break;
    // Replay leaves applied operations out of deps. Every remaining dependency
    // must be selected here, including when new work was queued during the cycle.
    if (!checked.has(item.op.id) || !item.deps.every(dep => selected.has(dep))) continue;
    const size = encoder.encode(JSON.stringify(item)).length;
    if (bytes + size + (items.length ? 1 : 0) > MAX_BATCH_BYTES) {
      if (items.length) break;
      const reason = "This change is too large to sync. Edit it or discard it.";
      state.queue = state.queue.map(row => row.op.id === item.op.id
        ? { ...row, state: "needsReview", reason, ruleError: { code: "invalid", reason, blocking: [] } }
        : row);
      continue;
    }
    bytes += size + (items.length ? 1 : 0);
    items.push(item);
    selected.add(item.op.id);
  }
  return items;
}

/** A cycle runs inside the device lock. Each local commit checks its original session. */
export async function syncLedger(
  db: LedgerDB, api: Api, epoch: string | undefined, now: () => number, publish: () => Promise<void>,
) {
  let state = await readLocal(db);
  assertSession(state, epoch);
  const checked = new Set(state.queue.map(row => row.op.id));
  const { generation, receipts } = await api.receipts([...checked]);
  const receiptList = [...receipts];
  let observed: OpsResponse = { generation, results: receipts };
  for (;;) {
    const items = await changeLocal(db, epoch, current => {
      observeResults(current, observed.generation, observed.results);
      return nextBatch(current, checked, now());
    });
    await publish();
    if (!items.length) break;
    assertSession(await readLocal(db), epoch);
    observed = await api.ops({ items });
    for (const { op } of items) checked.delete(op.id);
    for (const result of observed.results) if ("revision" in result) receiptList.push(result);
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
