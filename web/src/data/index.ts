/**
 * React data layer. Create one store per tab, call start() on mount and stop()
 * on cleanup, and read it with useSyncExternalStore(store.subscribe, store.getSnapshot).
 */
import * as ledger from "../ledger/index.ts";
import type { LedgerView, RuleError } from "../ledger/index.ts";
import { SETTINGS_ID } from "../types.ts";
import type {
  BackupFile, LedgerRecord, Me, Operation, Receipt, RecordByType, Records, RecordType, RestoreRequest, Snapshot,
} from "../types.ts";
import { AuthError, createApi, NetworkError, ServerError } from "./api.ts";
import { backupRecords, countRecords, parseBackup, reviewOperation, reviewRecord, validPatch } from "./backup.ts";
import { changeLocal, draft, finishLogout, LocalStateError, openLedger, purge, readLocal } from "./db.ts";
import type { LedgerDB, LocalState } from "./db.ts";
import { withSyncLock } from "./lock.ts";
import {
  affectedPeople, applyOperation, emptyRecords, findRecord, patchFields, proposedRecord, related, replay, unappliedOperations,
} from "./model.ts";
import type { QueueEntry } from "./model.ts";
import { ensureLatestApp } from "./service-worker.ts";
import { assertSession, importUnapplied, syncLedger } from "./sync.ts";

export { loginURL } from "./api.ts";
export { ensureLatestApp, registerServiceWorker } from "./service-worker.ts";

const UNDO_MS = 7000;
const POLL_MS = 30_000;

/** Capture these values when opening an edit or delete confirmation. */
export interface EditToken {
  generation: string;
  version: string;
}

export type SaveResult =
  | { status: "saved"; opId: string; recordId: string }
  | { status: "stale"; current: LedgerRecord | null; generation: string }
  | { status: "invalid"; error: RuleError }
  | { status: "signedOut" | "restoreInProgress" | "notReady" };

export interface ReviewItem {
  op: Operation;
  reason: string;
  code: RuleError["code"] | null;
  restore: boolean;
  local: LedgerRecord | null;
  server: LedgerRecord | null;
  blockingIds: string[];
  blocking: LedgerRecord[];
  waiting: Operation[];
  /** An earlier related change is still queued. */
  waitingOnEarlier?: boolean;
  /** The restored snapshot still needs to be committed on this device. */
  waitingForRestoredLedger?: boolean;
  /** Ledger generation when the server version was displayed. */
  generation?: string;
}

export interface StoreSnapshot {
  /** False until startup has checked the local session. */
  ready: boolean;
  buyer: Me | null;
  records: Records;
  ledger: LedgerView | null;
  generation: string | null;
  revision: number | null;
  /** Changes on sign-out. Use as a key to reset open forms and other private UI state. */
  sessionEpoch: string | null;
  sync: {
    pendingCount: number;
    offline: boolean;
    needsSignIn: boolean;
    needsReview: boolean;
    restoreInProgress: boolean;
    /** Hide login until the old server session has been revoked. */
    signOutPending: boolean;
    syncing: boolean;
    lastSyncAt: number | null;
    lastError: string | null;
  };
  reviewItems: ReviewItem[];
  pendingUndo: { op: Operation; deadline: number; personIds: string[] }[];
}

export interface RestorePreview {
  backup: BackupFile;
  generation: string;
  revision: number;
  currentCounts: ReturnType<typeof countRecords>;
  importedCounts: ReturnType<typeof countRecords>;
}

export interface StoreOptions {
  dbName?: string;
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  online?: () => boolean;
  /** Supply pure rule functions for isolated data-layer tests. */
  rules?: Pick<typeof ledger, "computeLedger" | "todayIn" | "validateChange" | "validateRecords">;
  /** Defaults to true in the browser. False disables browser listeners and timers. */
  automatic?: boolean;
  /** Override the online app-shell update gate. */
  ensureLatest?: () => Promise<boolean>;
}

export type SignOutResult =
  | { status: "needsConfirmation"; canSyncFirst: boolean }
  | { status: "signedOut"; pendingLogout: boolean };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function invalid(reason: string, code: RuleError["code"] = "invalid"): SaveResult {
  return { status: "invalid", error: { code, reason, blocking: [] } };
}

function noVersion(record: LedgerRecord) {
  const { version: _version, ...value } = record;
  return value;
}

function changedFields(current: LedgerRecord, fields: Record<string, unknown>) {
  const existing = { ...current } as Record<string, unknown>;
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => existing[key] !== value));
}

function reviewServer(snapshot: Snapshot | undefined, row: Extract<QueueEntry, { state: "needsReview" }>) {
  const { op, receipt } = row;
  if (receipt?.status === "conflict" &&
    (!snapshot || (snapshot.generation === receipt.generation && snapshot.revision < receipt.revision))) {
    return receipt.current;
  }
  return findRecord(snapshot ?? emptyRecords, op.recordType, op.recordId);
}

function waitsForRestoredLedger(row: Extract<QueueEntry, { state: "needsReview" }>, snapshot: Snapshot | undefined) {
  return !!row.restore && (!row.restoreGeneration || row.restoreGeneration !== snapshot?.generation);
}

function reviewLocal(current: LedgerRecord | null, row: Extract<QueueEntry, { state: "needsReview" }>) {
  const { op } = row;
  if (!row.restore) return row.local;
  if (op.kind === "update" && !validPatch(op.recordType, op.patch)) return null;
  return reviewRecord(op.recordType, op.kind === "delete" ? current : proposedRecord(current ?? row.local, reviewOperation(op)));
}

type ReviewAction = "keepServer" | "keepLocal" | "discard" | "editAndResubmit" | "confirmAlreadyReturned";
type NewPerson = Omit<RecordByType["person"], "id" | "version">;
type PurchaseFields = Omit<RecordByType["purchase"], "id" | "version">;

/** A framework-independent store backed by the browser's shared IndexedDB. */
export function createStore(options: StoreOptions = {}) {
  const api = createApi(options.fetch);
  const rules = options.rules ?? ledger;
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const online = options.online ?? (() => globalThis.navigator?.onLine ?? true);
  const automatic = options.automatic ?? typeof window !== "undefined";

  const listeners = new Set<() => void>();
  let db: LedgerDB | undefined;
  let channel: BroadcastChannel | undefined;
  let opening: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let syncRequested = false;
  let started = false;
  let masked = false;
  let epoch: string | undefined;
  let needsSignIn = false;
  let lastError: string | null = null;
  let publication = 0;
  let snapshot: StoreSnapshot = emptySnapshot();

  function emptySnapshot(): StoreSnapshot {
    return {
      ready: !!db && !masked, buyer: null, records: emptyRecords, ledger: null, generation: null, revision: null,
      sessionEpoch: epoch ?? null,
      sync: {
        pendingCount: 0, offline: !online(), needsSignIn, needsReview: false, restoreInProgress: false,
        signOutPending: false, syncing: !!running, lastSyncAt: null, lastError,
      },
      reviewItems: [], pendingUndo: [],
    };
  }

  function publish(value: StoreSnapshot) {
    snapshot = value;
    for (const listener of listeners) listener();
  }

  function announce(type: "change" | "signOut" | "restoreStart" | "restoreEnd") {
    channel?.postMessage({ type });
  }

  async function refresh() {
    if (!db) return;
    const version = ++publication;
    const state = await readLocal(db);
    if (version !== publication) return;
    if (epoch !== state.meta.epoch) {
      epoch = state.meta.epoch;
      needsSignIn = !state.meta.buyer;
      lastError = null;
    }
    if (masked || state.meta.signedOut) {
      const value = emptySnapshot();
      value.sync.signOutPending = !!state.meta.signedOut;
      value.sync.lastError = state.meta.signedOut?.error ?? lastError;
      publish(value);
      return;
    }

    const time = now();
    const view = replay(state.snapshot ?? emptyRecords, state.queue, time);
    const records = state.snapshot ? view.records : emptyRecords;
    const reviewItems = state.queue.flatMap(row => {
      if (row.state !== "needsReview") return [];
      const op = row.restore ? reviewOperation(row.op) : row.op;
      const blockingIds = row.receipt?.blocking ?? row.ruleError?.blocking ?? [];
      const all = state.snapshot ?? emptyRecords;
      const waitingForRestoredLedger = waitsForRestoredLedger(row, state.snapshot);
      const server = waitingForRestoredLedger ? null : reviewServer(state.snapshot, row);
      return [{
        op, reason: row.reason, code: row.receipt?.code ?? row.ruleError?.code ?? null, restore: !!row.restore,
        local: reviewLocal(server, row), server, blockingIds,
        generation: state.snapshot?.generation,
        waitingOnEarlier: view.reviewWaiting.has(op.id),
        waitingForRestoredLedger,
        blocking: [all.settings, ...all.people, ...all.purchases, ...all.payments, ...all.refunds, ...all.payouts]
          .filter((record): record is LedgerRecord => !!record && blockingIds.includes(record.id)),
        waiting: state.queue.filter(candidate => {
          const pending = [...view.waiting.get(candidate.op.id) ?? []];
          const visited = new Set<string>();
          while (pending.length) {
            const id = pending.pop()!;
            if (id === op.id) return true;
            if (!visited.has(id)) {
              visited.add(id);
              pending.push(...view.waiting.get(id) ?? []);
            }
          }
          return false;
        }).map(candidate => candidate.state === "needsReview" && candidate.restore
          ? reviewOperation(candidate.op) : candidate.op),
      }];
    });
    const pendingUndo = state.queue.flatMap(row => row.state === "pendingUndo" && row.deadline > time
      ? [{ op: row.op, deadline: row.deadline,
        personIds: undoPeople(row, state.snapshot ?? emptyRecords, records) }]
      : []);
    clearTimeout(undoTimer);
    if (automatic && started && pendingUndo.length) {
      undoTimer = setTimeout(() => { void syncNow(); },
        Math.max(0, Math.min(...pendingUndo.map(row => row.deadline)) - time));
    }
    publish({
      ready: true, buyer: state.meta.buyer ?? null, records,
      ledger: records.settings ? rules.computeLedger(records, rules.todayIn(records.settings.timeZone, time)) : null,
      generation: state.snapshot?.generation ?? null, revision: state.snapshot?.revision ?? null,
      sessionEpoch: epoch ?? null, reviewItems, pendingUndo,
      sync: {
        pendingCount: state.queue.length,
        offline: !online(),
        needsSignIn: !!state.meta.needsSignIn || !state.meta.buyer,
        needsReview: reviewItems.length > 0,
        restoreInProgress: !!state.meta.restore?.active,
        signOutPending: false,
        syncing: !!running,
        lastSyncAt: state.meta.lastSyncAt ?? null,
        lastError,
      },
    });
  }

  function requireDB(): LedgerDB {
    if (!db) throw new LocalStateError("notReady");
    return db;
  }

  async function verifyBuyer(state: LocalState, currentEpoch: string | undefined) {
    assertSession(state, currentEpoch);
    const buyer = await api.me();
    const latest = await readLocal(requireDB());
    assertSession(latest, currentEpoch);
    if (latest.meta.buyer && latest.meta.buyer.subject !== buyer.subject) throw new AuthError();
    return buyer;
  }

  async function logout(currentEpoch: string | undefined, error?: string) {
    if (error) throw new Error(error);
    if (!online()) return;
    try {
      await api.logout();
      await finishLogout(requireDB(), currentEpoch);
      announce("change");
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        await finishLogout(requireDB(), currentEpoch, message(error));
        announce("change");
      }
      throw error;
    } finally {
      needsSignIn = true;
    }
  }

  async function loadRestoredSnapshot(restored: Pick<Receipt, "generation" | "revision">, currentEpoch: string | undefined) {
    const database = requireDB();
    for (;;) {
      assertSession(await readLocal(database), currentEpoch);
      const fresh = await api.snapshot();
      if (fresh.generation === restored.generation && fresh.revision < restored.revision) continue;
      await changeLocal(database, currentEpoch, state => importUnapplied(state, fresh, now()), { duringRestore: true });
      return;
    }
  }

  async function releaseRestore(currentEpoch: string | undefined, recover: boolean, signIn = false) {
    await changeLocal(requireDB(), currentEpoch, state => {
      if (recover && state.meta.restore?.attempted) state.meta.restore.active = false;
      else delete state.meta.restore;
      if (signIn) state.meta.needsSignIn = true;
    }, { duringRestore: true });
    announce("restoreEnd");
  }

  // Recover a committed restore's unapplied work by receipt. An unchanged revision
  // also lets sync finish the already confirmed request with its original ID.
  async function recoverRestore(state: LocalState, currentEpoch: string | undefined, retry = false) {
    const request = state.meta.restore?.request;
    if (!request) return false;
    const database = requireDB();
    assertSession(await readLocal(database), currentEpoch);
    const { receipts } = await api.receipts([request.opId]);
    const receipt = receipts.find(receipt => receipt.opId === request.opId);
    if (receipt?.status === "applied") {
      await loadRestoredSnapshot(receipt, currentEpoch);
      announce("restoreEnd");
    } else if (receipt) {
      await releaseRestore(currentEpoch, false);
    } else {
      if (!retry || (await api.snapshot()).revision !== request.expectedRevision) return false;
      const retrying = await changeLocal(database, currentEpoch, local => {
        if (!local.meta.restore || local.queue.length) return false;
        local.meta.restore.active = true;
        return true;
      });
      if (!retrying) return false;
      announce("restoreStart");
      await refresh();
      await runRestore(request, currentEpoch);
    }
    return true;
  }

  async function cycle() {
    const database = requireDB();
    const state = await readLocal(database);
    const currentEpoch = state.meta.epoch;
    if (state.meta.signedOut) {
      await logout(currentEpoch, state.meta.signedOut.error);
      return;
    }
    if (state.meta.restore?.active) {
      // Owning the lock proves no live tab is performing the persisted restore.
      await releaseRestore(currentEpoch, true);
      await refresh();
    }
    if (!online()) return;
    try {
      const buyer = await verifyBuyer(state, currentEpoch);
      await changeLocal(database, currentEpoch, current => {
        current.meta.buyer = buyer;
        delete current.meta.needsSignIn;
      }, { duringRestore: true });
      needsSignIn = false;
      if (state.meta.restore?.attempted) await recoverRestore(state, currentEpoch, true);
      await syncLedger(database, api, currentEpoch, now, refresh);
      if (state.meta.restore?.attempted) {
        const fresh = await readLocal(database);
        // Resolve again if the revision advanced during sync. A missing receipt
        // after that advance means the interrupted request can no longer commit.
        if (fresh.meta.restore && fresh.snapshot && fresh.snapshot.revision > fresh.meta.restore.request.expectedRevision &&
            !await recoverRestore(fresh, currentEpoch)) {
          await releaseRestore(currentEpoch, false);
        }
      }
      lastError = null;
      announce("change");
    } catch (error) {
      assertSession(await readLocal(database), currentEpoch);
      if (error instanceof AuthError) {
        needsSignIn = true;
        await changeLocal(database, currentEpoch, current => { current.meta.needsSignIn = true; }, { duringRestore: true });
        announce("change");
      }
      throw error;
    }
  }

  function syncNow(): Promise<void> {
    if (!db) return Promise.resolve();
    syncRequested = true;
    if (running) return running;
    running = (async () => {
      do {
        syncRequested = false;
        try {
          await refresh();
          if (online() || snapshot.sync.restoreInProgress) await withSyncLock(cycle);
        } catch (error) {
          if (!(error instanceof LocalStateError && error.code === "signedOut")) lastError = message(error);
        }
      } while (syncRequested);
    })().finally(async () => {
      running = undefined;
      await refresh();
    });
    return running;
  }

  function onVisibility() {
    ++publication;
    masked = true;
    publish(emptySnapshot());
    if (document.visibilityState === "visible") {
      masked = false;
      void syncNow();
    }
  }

  function onMessage(event: MessageEvent) {
    if (event.data?.type === "signOut") {
      ++publication;
      needsSignIn = true;
      lastError = null;
      publish(emptySnapshot());
    }
    if (event.data?.type === "restoreStart") {
      publish({ ...snapshot, sync: { ...snapshot.sync, restoreInProgress: true } });
    }
    if (event.data?.type === "change" || event.data?.type === "signOut" ||
        event.data?.type === "restoreStart" || event.data?.type === "restoreEnd") void refresh();
  }

  function connect() {
    if (!automatic || interval !== undefined) return;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("family-tab");
      channel.addEventListener("message", onMessage);
    }
    window.addEventListener("online", syncNow);
    window.addEventListener("offline", syncNow);
    document.addEventListener("visibilitychange", onVisibility);
    interval = setInterval(() => {
      if (document.visibilityState === "visible") void syncNow();
    }, POLL_MS);
  }

  /** Check the app shell and the signed-out marker, then publish and sync. Safe to call repeatedly. */
  function start(): Promise<void> {
    started = true;
    if (opening) return opening;
    opening = (async () => {
      if (!db) {
        if (await (options.ensureLatest ?? ensureLatestApp)()) return;
        db = await openLedger(options.dbName ?? "family-tab");
      }
      if (!started) return;
      connect();
      await syncNow();
    })().finally(() => { opening = undefined; });
    return opening;
  }

  /** Stop browser listeners and timers. An in-flight sync can finish. */
  function stop() {
    started = false;
    clearInterval(interval);
    clearTimeout(undoTimer);
    interval = undefined;
    channel?.close();
    channel = undefined;
    if (automatic) {
      window.removeEventListener("online", syncNow);
      window.removeEventListener("offline", syncNow);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  }

  function enqueue(state: LocalState, op: Operation, before: Records, order?: number, dependencies?: string[]): SaveResult {
    const after = applyOperation(before, op);
    const zone = after.settings?.timeZone ?? before.settings?.timeZone ?? "UTC";
    let today: string;
    try { today = rules.todayIn(zone, now()); }
    catch { return invalid("Choose a valid ledger time zone."); }
    const error = rules.validateChange(before, after, op, today);
    if (error) return { status: "invalid", error };
    const row = {
      order: order ?? (state.queue.at(-1)?.order ?? 0) + 1,
      op, dependencies, people: affectedPeople(before, op),
      local: findRecord(after, op.recordType, op.recordId),
    };
    state.queue.push(op.kind === "delete" && order === undefined
      ? { ...row, state: "pendingUndo", deadline: now() + UNDO_MS }
      : { ...row, state: "sendable" });
    state.queue.sort((a, b) => a.order - b.order);
    return { status: "saved", opId: op.id, recordId: op.recordId };
  }

  function enqueueWithPerson(state: LocalState, op: Operation, before: Records, person?: NewPerson, replaced?: QueueEntry): SaveResult {
    if (!person) return enqueue(state, op, before, replaced?.order, replaced?.dependencies);
    if (op.recordType !== "purchase" || op.kind === "delete") {
      return invalid("A new person can only be added when saving a purchase.");
    }
    // Leave a slot before a purchase in Review, and publish neither change until both validate.
    const queue = replaced ? state.queue.map((entry, index) => ({ ...entry, order: (index + 1) * 2 })) : [...state.queue];
    const order = replaced ? queue[state.queue.indexOf(replaced)].order : (queue.at(-1)?.order ?? 0) + 2;
    const staging = { ...state, queue };
    const personId = uuid();
    const personOp: Operation = {
      ...newOperation(op.generation, "person", personId), kind: "create", record: { ...person, id: personId },
    };
    const created = enqueue(staging, personOp, before, order - 1);
    if (created.status !== "saved") return created;
    const purchaseOp = op.kind === "create" ? { ...op, record: { ...op.record, personId } }
      : { ...op, patch: { ...op.patch, personId } };
    const saved = enqueue(staging, purchaseOp, applyOperation(before, personOp), order, replaced?.dependencies);
    if (saved.status === "saved") state.queue = staging.queue;
    return saved;
  }

  async function localSave(change: (state: LocalState) => SaveResult): Promise<SaveResult> {
    try {
      const result = await changeLocal(requireDB(), epoch, change);
      if (result.status === "saved") await changed();
      if (result.status === "stale") await refresh();
      return result;
    } catch (error) {
      if (!(error instanceof LocalStateError)) throw error;
      await refresh();
      return { status: error.code };
    }
  }

  async function changed() {
    announce("change");
    const connected = online();
    await refresh();
    if (connected) void syncNow();
  }

  function newOperation(generation: string, recordType: RecordType, recordId: string) {
    return { id: uuid(), generation, recordType, recordId, createdAt: new Date(now()).toISOString() };
  }

  /** Create a record with a fresh ID. Use setup() to initialize ledger settings. */
  function createRecord<T extends Exclude<RecordType, "settings">>(
    type: T, input: Omit<RecordByType[T], "id" | "version">,
  ): Promise<SaveResult> {
    return create(type, uuid(), input);
  }

  function create<T extends RecordType>(type: T, id: string, input: Omit<RecordByType[T], "id" | "version">, person?: NewPerson) {
    return localSave(state => {
      if (!state.snapshot) return { status: "notReady" };
      const view = replay(state.snapshot, state.queue, now());
      const before = view.records;
      if (findRecord(before, type, id)) return invalid("This record already exists.", "duplicate_id");
      if (type === "settings" && state.queue.some(row => row.op.recordType === "settings" && row.op.kind === "create")) {
        return invalid("Resolve the pending setup change before starting setup again.");
      }
      if (type === "payout" && "personId" in input && typeof input.personId === "string" &&
          viewHasUndo(state, before, input.personId)) {
        return invalid("Wait for the undo window to end before recording cash returned.");
      }
      const record = { ...input, id } as Omit<LedgerRecord, "version">;
      return enqueueWithPerson(state, { ...newOperation(state.snapshot.generation, type, id), kind: "create", record }, before, person);
    });
  }

  function edit<T extends RecordType>(
    type: T, id: string, opened: EditToken, patch?: Partial<Omit<RecordByType[T], "id" | "version">>,
    person?: NewPerson,
  ): Promise<SaveResult> {
    return localSave(state => {
      if (!state.snapshot) return { status: "notReady" };
      const before = replay(state.snapshot, state.queue, now()).records;
      const current = findRecord(before, type, id);
      const generation = state.snapshot.generation;
      if (!current || generation !== opened.generation || current.version !== opened.version) {
        return { status: "stale", generation, current };
      }
      const base = { ...newOperation(generation, type, id), baseVersion: opened.version };
      const op: Operation = patch
        ? { ...base, kind: "update", patch: patchFields(type, changedFields(current, patch)) }
        : { ...base, kind: "delete", preImage: current };
      return enqueueWithPerson(state, op, before, person);
    });
  }

  /** Save a purchase and its new person in one local transaction. */
  function savePurchaseWithNewPerson(
    person: NewPerson, purchase: { fields: PurchaseFields } | { id: string; token: EditToken; patch: Partial<PurchaseFields> },
  ): Promise<SaveResult> {
    return "fields" in purchase ? create("purchase", uuid(), purchase.fields, person)
      : edit("purchase", purchase.id, purchase.token, purchase.patch, person);
  }

  function undoPeople(row: QueueEntry, snapshot: Records, local: Records) {
    return [...new Set([...row.people, ...affectedPeople(snapshot, row.op), ...affectedPeople(local, row.op)])];
  }

  function viewHasUndo(state: LocalState, records: Records, personId: string) {
    return state.queue.some(row => row.state === "pendingUndo" && row.deadline > now() &&
      undoPeople(row, state.snapshot ?? emptyRecords, records).includes(personId));
  }

  /** Cancel a deletion within its undo window, including pending deletions of its parents. */
  async function undo(opId: string): Promise<boolean> {
    const removed = await changeLocal(requireDB(), epoch, state => {
      const time = now();
      const row = state.queue.find(row => row.op.id === opId);
      if (!row || row.state !== "pendingUndo" || row.deadline <= time) return false;
      const op = row.op;
      if (op.kind !== "delete") return false;
      const purchaseId = op.recordType === "refund" && "purchaseId" in op.preImage ? op.preImage.purchaseId : null;
      const purchase = purchaseId === null ? undefined : state.queue.find(entry => entry.state === "pendingUndo" &&
        entry.op.recordType === "purchase" && entry.op.recordId === purchaseId);
      const child = purchase?.op ?? op;
      const personId = child.kind === "delete" && "personId" in child.preImage ? child.preImage.personId : null;
      const cancelled = state.queue.filter(entry => entry === row ||
        entry === purchase || (entry.state === "pendingUndo" && entry.op.recordType === "person" &&
          entry.op.recordId === personId)
      );
      state.queue = state.queue.filter(entry => !cancelled.includes(entry));
      // Validate related changes in replay order so a newly invalid change
      // holds its dependents out of the ledger before it is published.
      const synced = state.snapshot ?? emptyRecords;
      const affected = cancelled.map(entry => ({
        ...entry, people: [...entry.people, ...affectedPeople(synced, entry.op)],
      }));
      const { excluded } = replay(synced, state.queue, time, (before, after, entry) => {
        if (!affected.some(earlier => earlier.order < entry.order && related(earlier, entry))) return null;
        affected.push(entry);
        const zone = after.settings?.timeZone ?? before.settings?.timeZone ?? "UTC";
        const error = rules.validateChange(before, after, entry.op, rules.todayIn(zone, time));
        return error && { ...error, reason: `Undoing the deletion made this change invalid. ${error.reason}` };
      });
      const held = new Map(excluded.filter(entry => entry.state === "needsReview" && entry.ruleError)
        .map(entry => [entry.op.id, entry]));
      state.queue = state.queue.map(entry => held.get(entry.op.id) ?? entry);
      return true;
    });
    if (removed) await changed();
    return removed;
  }

  async function review(
    opId: string, action: ReviewAction, edited?: Record<string, unknown>, opened?: ReviewItem, newPerson?: NewPerson,
  ): Promise<SaveResult> {
    const reviewed = opened ?? snapshot.reviewItems.find(row => row.op.id === opId);
    const reviewedGeneration = reviewed?.generation ?? snapshot.generation;
    let heldPayout = false;
    const result = await localSave(state => {
      const row = state.queue.find(row => row.op.id === opId);
      if (!row || row.state !== "needsReview" || !state.snapshot || reviewed?.op.id !== opId) return invalid("Open Review again.");
      if (waitsForRestoredLedger(row, state.snapshot)) return invalid("Wait for the restored ledger to finish syncing.");
      const original = row.op;
      const generation = state.snapshot.generation;
      const current = reviewServer(state.snapshot, row);
      if (action !== "discard" && (reviewed.waitingForRestoredLedger ||
          reviewedGeneration !== generation || reviewed.server?.version !== current?.version)) {
        return { status: "stale", current, generation };
      }
      const remaining = state.queue.filter(entry => entry !== row);
      const done: SaveResult = { status: "saved", opId, recordId: original.recordId };
      if (action === "discard" || action === "keepServer") {
        state.queue = remaining;
        return done;
      }
      const time = now();
      if (replay(state.snapshot, state.queue, time).reviewWaiting.has(opId)) {
        return invalid("Wait for the earlier changes to be resolved.");
      }
      if (action === "confirmAlreadyReturned" && (original.recordType !== "payout" || original.kind === "delete")) {
        return invalid("Only a payout can be confirmed as money already returned.");
      }
      const local = row.restore ? reviewLocal(current, row) : reviewed.local;
      const keep = action === "keepLocal" || action === "confirmAlreadyReturned" ? local : null;
      if (action === "confirmAlreadyReturned" && !keep) return invalid("Open Review again to see the payout.");
      if (row.restore && !keep && !edited && (original.kind === "create" ||
          (original.kind === "update" && !validPatch(original.recordType, original.patch)))) {
        return invalid("Edit and resubmit this backup change before applying it.");
      }
      const before = replay(state.snapshot, remaining.filter(entry => entry.order < row.order), time).records;
      const base = {
        ...newOperation(generation, original.recordType, original.recordId),
        ...(action === "confirmAlreadyReturned" || original.alreadyReturned ? { alreadyReturned: true } : {}),
      };
      let op: Operation;
      if (original.kind === "delete") {
        if (newPerson) return invalid("A new person can only be added when saving a purchase.");
        if (!current) {
          state.queue = remaining;
          return done;
        }
        op = { ...base, kind: "delete", baseVersion: current.version, preImage: current };
      } else if (!current) {
        const replacement = keep ?? (row.restore ? local : row.local);
        const payload = replacement ? noVersion(replacement) : original.kind === "create" ? original.record : null;
        if (!payload && !edited && !newPerson) return invalid("Enter the full replacement record before resubmitting.");
        const record = { ...payload, ...edited, id: original.recordId } as LedgerRecord;
        op = { ...base, kind: "create", record: noVersion(record) };
      } else {
        const fields = keep ? noVersion(keep) :
          edited ?? (original.kind === "update" ? original.patch : original.record);
        const changes = keep || row.restore ? changedFields(current, fields) : fields;
        const patch = patchFields(original.recordType, changes);
        if (row.restore && original.kind === "create" && !edited &&
            Object.keys(patch).length !== Object.keys(changes).length) {
          return invalid("This change would modify a field that cannot be edited.");
        }
        if (row.restore && !Object.keys(patch).length && !newPerson) return invalid("This change has no differences from the restored ledger.");
        op = { ...base, kind: "update", baseVersion: current.version, patch };
      }
      const result = enqueueWithPerson(state, op, before, newPerson, row);
      let replacement: QueueEntry | undefined;
      if (op.recordType === "payout" && result.status === "invalid" &&
          result.error.code === "payout_exceeds_credit") {
        replacement = {
          op, order: row.order, dependencies: row.dependencies, state: "needsReview",
          people: affectedPeople(before, op), local: proposedRecord(current, op),
          reason: result.error.reason, ruleError: result.error,
        };
        heldPayout = true;
      }
      if (result.status === "saved" || replacement) {
        state.queue = state.queue.flatMap(entry => {
          if (entry.op.id === opId) return replacement ? [replacement] : [];
          return [entry.dependencies?.includes(opId)
            ? { ...entry, dependencies: entry.dependencies.map(id => id === opId ? op.id : id) }
            : entry];
        });
      }
      return result;
    });
    if (heldPayout) {
      announce("change");
      await refresh();
    }
    return result;
  }

  function keepServer(id: string): Promise<SaveResult>;
  function keepServer(id: string, opened?: ReviewItem): Promise<SaveResult>;
  function keepServer(id: string, opened?: ReviewItem) {
    return review(id, "keepServer", undefined, opened);
  }

  /** Warn about pending work, then atomically purge private data and arrange server logout. */
  async function signOut(confirmed = false): Promise<SignOutResult> {
    const database = requireDB();
    const result = await purge(database, epoch, uuid(), confirmed);
    if (result === "needsConfirmation") return { status: result, canSyncFirst: online() && !snapshot.sync.needsSignIn };
    needsSignIn = true;
    lastError = null;
    announce("signOut");
    await refresh();
    await syncNow();
    return { status: "signedOut", pendingLogout: !!(await readLocal(database)).meta.signedOut };
  }

  /** Export the optimistic ledger and its unapplied review work. Works offline. */
  async function exportBackup(): Promise<BackupFile> {
    const state = await readLocal(requireDB());
    assertSession(state, epoch);
    const view = replay(state.snapshot ?? emptyRecords, state.queue, now());
    const { settings, people, purchases, payments, refunds, payouts } = view.records;
    if (!settings) throw new Error("Set up the ledger before exporting it.");
    return {
      format: "family-tab-backup", formatVersion: 1, exportedAt: new Date(now()).toISOString(),
      currency: "TRY", timeZone: settings.timeZone, people, purchases, payments, refunds, payouts,
      unapplied: unappliedOperations(view.excluded, view.waiting),
    };
  }

  function validatedBackup(input: unknown) {
    const backup = parseBackup(input);
    const records = backupRecords(backup);
    let today: string;
    try { today = rules.todayIn(backup.timeZone, now()); }
    catch { throw new Error("The backup has an invalid time zone."); }
    const error = rules.validateRecords(records, today);
    if (error) throw new Error(error.reason);
    return { backup, records };
  }

  /** Validate JSON or a parsed backup and fetch replacement counts and revision without taking the lock. */
  async function previewRestore(input: unknown): Promise<RestorePreview> {
    const { backup, records } = validatedBackup(input);
    if (!online()) throw new Error("Connect to the server to restore a backup.");
    const database = requireDB();
    const currentEpoch = epoch;
    const state = await readLocal(database);
    assertSession(state, currentEpoch);
    await verifyBuyer(state, currentEpoch);
    const current = await api.snapshot();
    assertSession(await readLocal(database), currentEpoch);
    return {
      backup, revision: current.revision, generation: current.generation,
      currentCounts: countRecords(current), importedCounts: countRecords(records),
    };
  }

  async function runRestore(request: RestoreRequest, currentEpoch: string | undefined, generation?: string) {
    let rejected = false;
    try {
      const database = requireDB();
      if (generation !== undefined) {
        const current = await api.snapshot();
        if (current.generation !== generation || current.revision !== request.expectedRevision) {
          throw new Error("The ledger changed. Preview the backup again.");
        }
      }
      await changeLocal(database, currentEpoch, state => {
        if (state.meta.restore) state.meta.restore.attempted = true;
      }, { duringRestore: true });
      const restored = await api.restore(request).catch(error => {
        rejected = error instanceof ServerError && error.status >= 400 && error.status < 500 &&
          error.status !== 401;
        throw error;
      });
      if (restored.status === "rejected") {
        rejected = true;
        throw new Error(restored.reason ?? "The ledger changed. Preview the backup again.");
      }
      await loadRestoredSnapshot(restored, currentEpoch);
      lastError = null;
      announce("restoreEnd");
    } catch (error) {
      const state = await readLocal(requireDB());
      assertSession(state, currentEpoch);
      const signIn = error instanceof AuthError;
      if (signIn) needsSignIn = true;
      await releaseRestore(currentEpoch, !rejected, signIn);
      lastError = message(error);
      throw error;
    } finally {
      await refresh();
    }
  }

  /** Confirm the preview. Reject if offline, the queue has work, or the server revision changed. */
  async function commitRestore(preview: RestorePreview) {
    const { backup } = validatedBackup(preview.backup);
    if (!online()) throw new Error("Connect to the server to restore a backup.");
    const currentEpoch = epoch;
    const database = requireDB();
    await withSyncLock(async () => {
      if (!online()) throw new Error("Connect to the server to restore a backup.");
      const request = { backup, expectedRevision: preview.revision, opId: uuid() };
      const before = await readLocal(database);
      await verifyBuyer(before, currentEpoch);
      if (before.meta.restore?.active) await releaseRestore(currentEpoch, true);
      if (before.meta.restore?.attempted && await recoverRestore(before, currentEpoch)) await refresh();
      await changeLocal(database, currentEpoch, state => {
        if (state.meta.restore?.attempted) {
          throw new Error("The previous restore is still unresolved. Sync to check its result before restoring again.");
        }
        if (state.queue.length) throw new Error("Resolve and sync pending changes before restoring.");
        state.meta.restore = { request, active: true, attempted: false };
      });
      announce("restoreStart");
      await refresh();
      await runRestore(request, currentEpoch, preview.generation);
    });
  }

  /** Update local state without forcing network access, for example after returning to the foreground. */
  async function refreshLocal() {
    await refresh();
  }

  return {
    /** Subscribe to immutable snapshots for useSyncExternalStore. */
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    start, stop, refreshLocal,
    /** Trigger a sync cycle and wait for the published status. Errors are shown in sync.lastError. */
    syncNow,
    /** Start the ledger with the selected IANA time zone. */
    setup: (timeZone: string) => create("settings", SETTINGS_ID, { timeZone, currency: "TRY" }),
    createRecord, savePurchaseWithNewPerson,
    /** Apply a field-level patch if the captured generation and record version still match. */
    updateRecord: <T extends RecordType>(
      type: T, id: string, opened: EditToken, patch: Partial<Omit<RecordByType[T], "id" | "version">>,
    ) => edit(type, id, opened, patch),
    /** Apply a deletion locally and give it a seven-second undo window. */
    deleteRecord: (type: Exclude<RecordType, "settings">, id: string, opened: EditToken) => edit(type, id, opened),
    undo,
    /** True when no deletion affecting this person is inside its undo window. Check credit separately. */
    canRecordCashReturned: (personId: string) => !snapshot.pendingUndo.some(row =>
      row.deadline > now() && row.personIds.includes(personId)),
    /** Pass the displayed item to guard the decision against a newer version. */
    keepServer,
    /** Pass the captured item when the form can stay open across a refresh. */
    keepLocal: (id: string, opened?: ReviewItem) => review(id, "keepLocal", undefined, opened),
    discard: (id: string) => review(id, "discard"),
    /**
     * Resubmit with a replacement patch, or full fields to recreate a record.
     * Pass the captured item to use the server version shown when the form opened.
     * For a purchase with a new person, queue the person's creation before the purchase.
     */
    editAndResubmit: (id: string, fields: Record<string, unknown>, opened?: ReviewItem, newPerson?: NewPerson) =>
      review(id, "editAndResubmit", fields, opened, newPerson),
    /** Resubmit a payout the buyer already made, even if it now exceeds credit. */
    confirmAlreadyReturned: (id: string, opened?: ReviewItem) => review(id, "confirmAlreadyReturned", undefined, opened),
    signOut, exportBackup, previewRestore, commitRestore,
    /** Optional draft persistence. Pass undefined to delete a draft. */
    saveDraft: (key: string, value: unknown) => draft(requireDB(), epoch, key, { value }),
    loadDraft: (key: string) => draft(requireDB(), epoch, key),
  };
}

export type FamilyTabStore = ReturnType<typeof createStore>;
