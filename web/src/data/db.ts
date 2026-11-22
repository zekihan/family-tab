import { openDB } from "idb";
import type { DBSchema } from "idb";
import type { Me, RestoreRequest, Snapshot } from "../types.ts";
import type { QueueEntry } from "./model.ts";

export interface Meta {
  epoch?: string;
  signedOut?: { error?: string };
  buyer?: Me;
  needsSignIn?: boolean;
  lastSyncAt?: number;
  restore?: { request: RestoreRequest; active: boolean; attempted: boolean };
}

interface FamilyTabDB extends DBSchema {
  meta: { key: string; value: Meta };
  snapshot: { key: string; value: Snapshot };
  queue: { key: string; value: QueueEntry };
  drafts: { key: string; value: unknown };
}

export function openLedger(name: string) {
  return openDB<FamilyTabDB>(name, 1, {
    upgrade(db) {
      db.createObjectStore("meta");
      db.createObjectStore("snapshot");
      db.createObjectStore("queue", { keyPath: "op.id" });
      db.createObjectStore("drafts");
    },
    blocking(_current, _next, event) {
      (event.target as IDBDatabase).close();
    },
  });
}

export type LedgerDB = Awaited<ReturnType<typeof openLedger>>;

const stores = ["meta", "snapshot", "queue", "drafts"] as const;
const key = "ledger";

export class LocalStateError extends Error {
  readonly code: "signedOut" | "restoreInProgress" | "notReady";

  constructor(code: LocalStateError["code"]) {
    super({
      signedOut: "This session has signed out.",
      restoreInProgress: "Restore in progress.",
      notReady: "Download the ledger before saving changes.",
    }[code]);
    this.code = code;
  }
}

async function readState(tx: ReturnType<LedgerDB["transaction"]>) {
  const [meta, snapshot, queue] = await Promise.all([
    tx.objectStore("meta").get(key) as Promise<Meta | undefined>,
    tx.objectStore("snapshot").get(key) as Promise<Snapshot | undefined>,
    tx.objectStore("queue").getAll() as Promise<QueueEntry[]>,
  ]);
  return { meta: meta ?? {}, snapshot, queue: queue.sort((a, b) => a.order - b.order) };
}

export type LocalState = Awaited<ReturnType<typeof readState>>;

export async function readLocal(db: LedgerDB) {
  const tx = db.transaction(stores, "readonly");
  const state = await readState(tx);
  await tx.done;
  return state;
}

export async function changeLocal<T>(
  db: LedgerDB,
  epoch: string | undefined,
  change: (state: LocalState) => T,
  options: { duringRestore?: boolean } = {},
): Promise<T> {
  const tx = db.transaction(stores, "readwrite");
  const state = await readState(tx);
  let result: T;
  try {
    if (state.meta.signedOut || state.meta.epoch !== epoch) throw new LocalStateError("signedOut");
    if (!options.duringRestore && state.meta.restore?.active) throw new LocalStateError("restoreInProgress");
    const previousMeta = JSON.stringify(state.meta);
    const previousSnapshot = state.snapshot;
    const previousQueue = new Map(state.queue.map(row => [row.op.id, row]));
    result = change(state);
    const writes: Promise<unknown>[] = [];
    if (JSON.stringify(state.meta) !== previousMeta) writes.push(tx.objectStore("meta").put(state.meta, key));
    if (state.snapshot !== previousSnapshot) {
      const snapshots = tx.objectStore("snapshot");
      writes.push(state.snapshot ? snapshots.put(state.snapshot, key) : snapshots.delete(key));
    }
    const queue = tx.objectStore("queue");
    for (const row of state.queue) {
      if (previousQueue.get(row.op.id) !== row) writes.push(queue.put(row));
      previousQueue.delete(row.op.id);
    }
    for (const id of previousQueue.keys()) writes.push(queue.delete(id));
    await Promise.all([...writes, tx.done]);
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished. */ }
    await tx.done.catch(() => undefined);
    throw error;
  }
  return result;
}

export async function purge(db: LedgerDB, epoch: string | undefined, nextEpoch: string, confirmed: boolean) {
  const tx = db.transaction(stores, "readwrite");
  const state = await readState(tx);
  if (state.meta.epoch !== epoch || state.meta.signedOut) {
    await tx.done;
    return "signedOut";
  }
  if (state.queue.length && !confirmed) {
    await tx.done;
    return "needsConfirmation";
  }
  await Promise.all([
    tx.objectStore("meta").put({ epoch: nextEpoch, signedOut: {} }, key),
    tx.objectStore("snapshot").clear(), tx.objectStore("queue").clear(), tx.objectStore("drafts").clear(), tx.done,
  ]);
  return "signedOut";
}

export async function finishLogout(db: LedgerDB, epoch: string | undefined, error?: string) {
  const tx = db.transaction("meta", "readwrite");
  const meta = await tx.store.get(key);
  if (meta?.signedOut && meta.epoch === epoch) {
    await tx.store.put({ epoch, signedOut: error ? { error } : undefined }, key);
  }
  await tx.done;
}

export async function draft(db: LedgerDB, epoch: string | undefined, id: string, write?: { value: unknown }) {
  const tx = db.transaction(["meta", "drafts"], "readwrite");
  const meta = await tx.objectStore("meta").get(key);
  const blocked = meta?.signedOut || meta?.epoch !== epoch
    ? "signedOut" : write && meta?.restore?.active ? "restoreInProgress" : null;
  if (blocked) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new LocalStateError(blocked);
  }
  const drafts = tx.objectStore("drafts");
  const value = write
    ? await (write.value === undefined ? drafts.delete(id) : drafts.put(write.value, id))
    : await drafts.get(id);
  await tx.done;
  return value;
}
