import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { changeLocal, openLedger, readLocal } from "../../src/data/db.ts";
import { applyOperation } from "../../src/data/model.ts";
import type { Operation } from "../../src/types.ts";
import { backup, deferred, harness, initial, payment, person, purchase, refund, token } from "./helpers.ts";

test("offline edits are persisted and stale form saves return the current record", async () => {
  const { store, createAnother, clock } = harness();
  await store.start();
  const opened = token(store, person);
  clock.online = false;
  const otherTab = createAnother();
  await otherTab.start();
  assert.equal((await store.updateRecord("person", person.id, opened, { name: "First" })).status, "saved");
  const result = await otherTab.updateRecord("person", person.id, opened, { name: "Second" });
  assert.equal(result.status, "stale");
  if (result.status === "stale") assert.deepEqual(result.current, store.getSnapshot().records.people[0]);
});

test("refund and purchase deletion survive reload, block payout, and undo restores both IDs", async () => {
  const { store, createAnother, clock, server } = harness();
  await store.start();
  clock.online = false;
  const removal = await store.deleteRecord("refund", refund.id, token(store, refund));
  assert.equal(removal.status, "saved");
  assert.equal((await store.deleteRecord("purchase", purchase.id, token(store, purchase))).status, "saved");
  assert.equal((await store.deleteRecord("person", person.id, token(store, person))).status, "saved");
  const file = await store.exportBackup();
  assert.deepEqual(file.refunds, []);
  assert.deepEqual(file.purchases, []);
  assert.equal(store.canRecordCashReturned("a"), false);
  assert.equal(store.canRecordCashReturned("b"), true);
  const blocked = await store.createRecord("payout", { personId: "a", amountMinor: 1, paidOutOn: "2026-11-22", note: null });
  assert.equal(blocked.status, "invalid");
  clock.now += 5000;
  const reloaded = createAnother();
  await reloaded.start();
  assert.equal(reloaded.getSnapshot().pendingUndo[0].deadline - clock.now, 2000);
  assert.equal(removal.status === "saved" && await reloaded.undo(removal.opId), true);
  assert.deepEqual(reloaded.getSnapshot().records.people, initial().people);
  assert.deepEqual(reloaded.getSnapshot().records.purchases, [purchase]);
  assert.deepEqual(reloaded.getSnapshot().records.refunds, [refund]);
  const again = await reloaded.deleteRecord("refund", refund.id, token(reloaded, refund));
  clock.now += 7000;
  clock.online = true;
  assert.equal(again.status === "saved" && await reloaded.undo(again.opId), false);
  await reloaded.syncNow();
  assert.equal(reloaded.canRecordCashReturned("a"), true);
  assert.equal(server.snapshot.refunds.length, 0);
});

test("undoing a purchase, payment or payout deletion also restores its person", async t => {
  const paid = { ...payment(), id: "payment", version: "initial-payment" };
  const paidOut = {
    id: "payout", version: "initial-payout", personId: person.id, amountMinor: 1, paidOutOn: "2026-11-22", note: null,
  };
  for (const [type, collection, record] of [
    ["purchase", "purchases", purchase],
    ["payment", "payments", paid],
    ["payout", "payouts", paidOut],
  ] as const) {
    await t.test(type, async () => {
      const { store, clock, server } = harness();
      server.replace({ ...initial(), refunds: [], purchases: [], [collection]: [record] });
      await store.start();
      clock.online = false;
      const removed = await store.deleteRecord(type, record.id, token(store, record));
      assert.equal(removed.status, "saved");
      assert.equal((await store.deleteRecord("person", person.id, token(store, person))).status, "saved");
      assert.deepEqual(store.getSnapshot().records.people.map(row => row.id), ["b"]);
      assert.equal(await store.undo(removed.opId), true);
      assert.deepEqual(store.getSnapshot().records[collection], [record]);
      assert.deepEqual(store.getSnapshot().records.people, initial().people);
      assert.deepEqual(store.getSnapshot().pendingUndo, []);
    });
  }
});

test("applied ops clear; rejection and conflict block their dependents while unrelated ops sync", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  server.result.decide = op => op.kind === "update" && (op.patch.item === "Local")
    ? { status: "conflict", code: "conflict", current: { ...purchase, item: "Server", version: "server-edit" }, reason: "Edited elsewhere" }
    : op.kind === "create" && op.recordType === "payout" && !op.alreadyReturned
      ? { status: "rejected", code: "payout_exceeds_credit", blocking: [purchase.id], reason: "Above credit" }
      : undefined;
  server.replace({ ...initial(), purchases: [{ ...purchase, item: "Server", version: "server-edit" }] });
  const conflict = await store.updateRecord("purchase", purchase.id, token(store, purchase), { item: "Local" });
  assert.equal(conflict.status, "saved");
  const waiting = await store.createRecord("payment", payment("a"));
  assert.equal(waiting.status, "saved");
  const independent = await store.createRecord("payment", payment("b"));
  assert.equal(independent.status, "saved");
  const rejected = await store.createRecord("payout", { personId: "b", amountMinor: 1, paidOutOn: "2026-11-22", note: null });
  assert.equal(rejected.status, "saved");
  clock.online = true;
  await store.syncNow();
  const current = store.getSnapshot();
  assert.equal(current.sync.pendingCount, 3);
  assert.deepEqual(current.records.payments.map(row => row.personId), ["b"]);
  const [first, second] = current.reviewItems;
  assert.equal(first.server?.version, "server-edit");
  assert.equal(first.local?.version, conflict.opId);
  assert.deepEqual(first.waiting.map(op => op.id), [waiting.opId]);
  assert.equal(second.code, "payout_exceeds_credit");
  assert.deepEqual(second.blocking.map(row => row.id), [purchase.id]);
  assert.deepEqual(server.operations[0].items.map(item => item.deps), [[], [conflict.opId], [], [independent.opId]]);
  const exported = await store.exportBackup();
  assert.deepEqual(exported.unapplied.map(row => [row.op.id, row.dependencies, row.reason]), [
    [conflict.opId, [], "Edited elsewhere"], [waiting.opId, [conflict.opId], null],
    [rejected.opId, [], "Above credit"],
  ]);
  await store.syncNow();
  assert.equal(server.operations.length, 1);
  server.result.decide = op => op.id === rejected.opId
    ? { status: "rejected", code: "payout_exceeds_credit" } : undefined;
  assert.equal((await store.keepLocal(conflict.opId)).status, "saved");
  assert.equal((await store.confirmAlreadyReturned(rejected.opId)).status, "saved");
  await store.syncNow();
  const sent = server.operations.slice(1).flatMap(request => request.items.map(item => item.op));
  const replaced = sent.find(op => op.recordId === purchase.id);
  assert.ok(replaced?.kind === "update");
  assert.notEqual(replaced.id, conflict.opId);
  assert.equal(replaced.baseVersion, "server-edit");
  assert.equal(sent.find(op => op.recordType === "payout")?.alreadyReturned, true);
  assert.equal(store.getSnapshot().sync.pendingCount, 0);
});

test("a missing server record can be recreated with its original ID", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  const saved = await store.updateRecord("person", person.id, token(store, person), { name: "Edited" });
  assert.equal(saved.status, "saved");
  server.replace({ ...initial(), people: [initial().people[1]] });
  server.result.decide = op => op.id === saved.opId
    ? { status: "conflict", code: "conflict", current: null } : undefined;
  clock.online = true;
  await store.syncNow();
  assert.equal((await store.keepLocal(saved.opId)).status, "saved");
  await store.syncNow();
  assert.equal(server.snapshot.people.find(row => row.id === person.id)?.name, "Edited");
});

test("held operations enter restore review and operations reflected by the new generation disappear", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  const applied = await store.createRecord("payment", payment("a"));
  const held = await store.createRecord("payment", payment("b"));
  assert.equal(applied.status, "saved");
  assert.equal(held.status, "saved");
  const dbState = store.getSnapshot();
  let switched = false;
  server.hook.fetch = async path => {
    if (path === "/api/sync/ops" && !switched) {
      switched = true;
      server.replace({ ...initial(), generation: "generation-2", revision: 4, payments: dbState.records.payments.slice(0, 1) });
    }
    return undefined;
  };
  clock.online = true;
  await store.syncNow();
  assert.deepEqual(store.getSnapshot().reviewItems.map(row => [row.op.id, row.restore]), [[held.opId, true]]);
  assert.equal(store.getSnapshot().sync.pendingCount, 1);
  assert.equal(store.getSnapshot().generation, "generation-2");
  const stale = await store.updateRecord("person", person.id, { generation: "generation-1", version: person.version }, { name: "Old" });
  assert.equal(stale.status, "stale");
});

test("a changed generation reported by receipts moves queued work to review before any send", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  await store.createRecord("payment", payment());
  server.replace({ ...initial(), generation: "new", revision: 4 });
  clock.online = true;
  await store.syncNow();
  assert.equal(server.operations.length, 0);
  assert.equal(store.getSnapshot().reviewItems[0].restore, true);
});

test("a newer receipt forces refetch; an interrupted commit retries by stored receipt", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  await store.createRecord("payment", payment());
  let requests = 0;
  server.hook.fetch = async path => {
    if (path !== "/api/snapshot") return undefined;
    requests += 1;
    if (requests === 1) return Response.json(initial());
    if (requests === 2) throw new TypeError("disconnected");
    return undefined;
  };
  clock.online = true;
  await store.syncNow();
  assert.equal(requests, 2);
  assert.equal(store.getSnapshot().sync.pendingCount, 1);
  assert.equal(store.getSnapshot().records.payments.length, 1);
  await store.syncNow();
  assert.equal(store.getSnapshot().sync.pendingCount, 0);
  assert.equal(server.operations.length, 1);
  assert.equal(server.snapshot.payments.length, 1);
});

test("expired auth preserves the queue and sync resumes only for the same subject", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  await store.createRecord("payment", payment());
  clock.online = true;
  server.signIn(null);
  await store.syncNow();
  assert.equal(store.getSnapshot().sync.needsSignIn, true);
  assert.equal(store.getSnapshot().records.payments.length, 1);
  server.signIn("other");
  await store.syncNow();
  assert.equal(store.getSnapshot().sync.pendingCount, 1);
  assert.equal(server.operations.length, 0);
  server.signIn("buyer");
  await store.syncNow();
  assert.equal(store.getSnapshot().sync.needsSignIn, false);
  assert.equal(server.operations.length, 1);
});

test("offline sign-out purges atomically, guards stale writers, and only logs out on reconnect", async () => {
  const { store, clock, server, dbName, createAnother } = harness();
  await store.start();
  clock.online = false;
  await store.createRecord("payment", payment());
  await store.saveDraft("secret", { form: "private" });
  const oldTab = createAnother();
  await oldTab.start();
  assert.deepEqual(await store.signOut(), { status: "needsConfirmation", canSyncFirst: false });
  assert.deepEqual(await store.signOut(true), { status: "signedOut", pendingLogout: true });
  const db = await openLedger(dbName);
  const local = await readLocal(db);
  assert.ok(local.meta.signedOut);
  assert.equal(local.meta.buyer, undefined);
  assert.equal(local.snapshot, undefined);
  assert.deepEqual(local.queue, []);
  assert.deepEqual(await db.getAll("drafts"), []);
  await assert.rejects(changeLocal(db, local.meta.epoch, () => assert.fail("blocked transaction invoked mutation")));
  assert.equal((await oldTab.createRecord("payment", payment())).status, "signedOut");
  server.calls.length = 0;
  clock.online = true;
  const reloaded = createAnother();
  await reloaded.start();
  assert.deepEqual(server.calls.map(call => call.path), ["/api/logout"]);
  assert.equal((await readLocal(db)).meta.signedOut, undefined);
  assert.equal(reloaded.getSnapshot().records.people.length, 0);
  assert.equal(reloaded.getSnapshot().sync.needsSignIn, true);
});

test("network logout failures retry, HTTP failures stop further requests", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  await store.signOut();
  clock.online = true;
  let attempts = 0;
  server.hook.fetch = async path => {
    assert.equal(path, "/api/logout");
    attempts += 1;
    if (attempts === 1) throw new TypeError("Disconnected");
    return Response.json({ error: "internal", message: "Server failure" }, { status: 500 });
  };
  await store.syncNow();
  await store.syncNow();
  await store.syncNow();
  assert.equal(attempts, 2);
  assert.equal(store.getSnapshot().sync.lastError, "Server failure");
  assert.equal(store.getSnapshot().sync.signOutPending, true);
});

test("sign-out discards in-flight snapshot results and serializes logout", async () => {
  const { store, server, createAnother, dbName } = harness();
  await store.start();
  const entered = deferred<void>();
  const release = deferred<void>();
  server.hook.fetch = async path => {
    if (path === "/api/snapshot") {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const another = createAnother();
  // Open offline data first, then pause a cycle in the original tab.
  const loading = another.start();
  await entered.promise;
  const signingOut = store.signOut(true);
  const db = await openLedger(dbName);
  for (;;) {
    if ((await readLocal(db)).meta.signedOut) break;
  }
  release.resolve();
  await Promise.all([loading, signingOut]);
  assert.equal(another.getSnapshot().records.people.length, 0);
  assert.equal((await readLocal(db)).snapshot, undefined);
});

test("restore checks connectivity, revision and an empty queue, then imports unapplied operations", async () => {
  const { store, server, clock, createAnother } = harness();
  await store.start();
  const original = initial();
  const op: Operation = { id: "example", generation: original.generation, kind: "update", recordType: "person",
    recordId: person.id, createdAt: "2026-11-22T00:00:00Z", baseVersion: person.version, patch: { name: "New" } };
  const already: Operation = { ...op, id: "already", patch: { name: person.name } };
  const file = backup([
    { order: 1, op: already, dependencies: [], reason: null },
    { order: 2, op, dependencies: [already.id], reason: "Previous rejection" },
  ]);
  const preview = await store.previewRestore(file);
  assert.equal(preview.currentCounts.people, 2);
  clock.online = false;
  await assert.rejects(store.commitRestore(preview), /Connect/);
  clock.online = true;
  server.replace({ ...original, revision: 4 });
  await assert.rejects(store.commitRestore(preview), /Preview/);
  const next = await store.previewRestore(file);
  const entered = deferred<void>();
  const release = deferred<void>();
  const another = createAnother();
  await another.start();
  server.hook.fetch = async path => {
    if (path === "/api/restore") {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const restoring = store.commitRestore(next);
  await entered.promise;
  assert.equal(store.getSnapshot().sync.restoreInProgress, true);
  assert.equal((await another.createRecord("payment", payment())).status, "restoreInProgress");
  release.resolve();
  await restoring;
  const state = store.getSnapshot();
  assert.equal(state.sync.restoreInProgress, false);
  assert.notEqual(state.generation, original.generation);
  assert.deepEqual(state.reviewItems.map(row => [row.op.id, row.reason, row.restore]), [[op.id, "Previous rejection", true]]);
  assert.deepEqual(state.records.people, original.people);
  await assert.rejects(store.commitRestore(await store.previewRestore(file)), /pending changes/);
});

test("restore review update uses the restored record as a base", async () => {
  const { store, server } = harness();
  await store.start();
  const op: Operation = { id: "update", recordType: "person", recordId: person.id, kind: "update",
    baseVersion: person.version, generation: initial().generation, createdAt: "2026-11-22T00:00:00Z",
    patch: { name: "Updated" } };
  const file = backup([{ order: 0, op, dependencies: [], reason: null }]);
  await store.commitRestore(await store.previewRestore(file));
  assert.equal((await store.editAndResubmit(op.id, { name: "Edited" })).status, "saved");
  await store.syncNow();
  const sent = server.operations[0].items[0].op;
  assert.equal(sent.kind === "update" && sent.baseVersion, person.version);
  assert.equal(applyOperation(initial(), sent).people[0].name, "Edited");
});

test("an interrupted restore releases saves and recovers unapplied work using its receipt", async () => {
  const { store, server } = harness();
  await store.start();
  const op: Operation = { id: "update", recordType: "person", recordId: person.id, kind: "update",
    baseVersion: person.version, generation: initial().generation, createdAt: "2026-11-22T00:00:00Z",
    patch: { name: "From backup" } };
  const preview = await store.previewRestore(backup([{ order: 0, op, dependencies: [], reason: null }]));
  let restores = 0;
  server.hook.fetch = async path => {
    if (path === "/api/restore") restores += 1;
    if (path === "/api/snapshot" && restores > 0) throw new TypeError("Disconnected");
    return undefined;
  };
  await assert.rejects(store.commitRestore(preview), /Could not reach/);
  assert.equal(store.getSnapshot().sync.restoreInProgress, false);
  server.hook.fetch = undefined;
  await store.syncNow();
  assert.equal(restores, 1);
  assert.equal(store.getSnapshot().generation, server.snapshot.generation);
  assert.deepEqual(store.getSnapshot().reviewItems.map(row => row.op.id), [op.id]);
});

test("a second restore preserves unapplied work when the first commits after a missing receipt", async () => {
  const { store, server } = harness();
  await store.start();
  const op: Operation = { id: "unapplied", recordType: "person", recordId: person.id, kind: "update",
    baseVersion: person.version, generation: initial().generation, createdAt: "2026-11-22T00:00:00Z",
    patch: { name: "From first backup" } };
  const first = await store.previewRestore(backup([{ order: 0, op, dependencies: [], reason: null }]));
  const second = await store.previewRestore(backup());
  server.hook.fetch = async path => {
    if (path === "/api/restore") throw new TypeError("Disconnected");
    return undefined;
  };
  await assert.rejects(store.commitRestore(first), /Could not reach/);
  const request = server.calls.find(call => call.path === "/api/restore");
  assert.ok(request);
  let checkedMissingReceipt = false;
  server.hook.fetch = async path => {
    if (path === "/api/sync/receipts" && !checkedMissingReceipt) {
      checkedMissingReceipt = true;
      assert.equal(server.receipts.size, 0);
    }
    if (path === "/api/snapshot" && checkedMissingReceipt) {
      server.hook.fetch = undefined;
      const response = await server.fetch("/api/restore", { method: "POST", body: JSON.stringify(request.body) });
      assert.equal((await response.json()).status, "applied");
    }
    return undefined;
  };
  await assert.rejects(store.commitRestore(second), /previous restore|preview/i);
  assert.equal(checkedMissingReceipt, true);
  await store.syncNow();
  assert.equal(store.getSnapshot().generation, server.snapshot.generation);
  assert.deepEqual(store.getSnapshot().reviewItems.map(row => [row.op.id, row.restore]), [[op.id, true]]);
});

test("a lost apply response is reconciled from the stored receipt without sending the operation twice", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  const saved = await store.createRecord("payment", payment());
  assert.equal(saved.status, "saved");
  server.hook.fetch = async path => {
    if (path !== "/api/sync/ops") return undefined;
    const row = store.getSnapshot().records.payments[0];
    server.replace({ ...server.snapshot, payments: [row], revision: server.snapshot.revision + 1 });
    server.receipts.set(saved.opId, {
      opId: saved.opId, status: "applied", code: null, reason: null, blocking: [], current: null,
      generation: server.snapshot.generation, revision: server.snapshot.revision,
    });
    throw new TypeError("Response lost");
  };
  clock.online = true;
  await store.syncNow();
  assert.equal(store.getSnapshot().sync.pendingCount, 1);
  server.hook.fetch = undefined;
  await store.syncNow();
  assert.equal(store.getSnapshot().sync.pendingCount, 0);
  assert.equal(server.calls.filter(call => call.path === "/api/sync/ops").length, 1);
});
