import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { changeLocal, openLedger, readLocal } from "../../src/data/db.ts";
import { createStore } from "../../src/data/index.ts";
import { applyOperation } from "../../src/data/model.ts";
import * as ledger from "../../src/ledger/index.ts";
import type { Operation, RestoreRequest } from "../../src/types.ts";
import { reviewActions } from "../../src/ui/presentation.ts";
import { backup, deferred, harness, initial, other, payment, person, purchase, refund, token } from "./helpers.ts";

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
  assert.equal(store.canRecordCashReturned(person.id), false);
  assert.equal(store.canRecordCashReturned(other.id), true);
  const blocked = await store.createRecord("payout", { personId: person.id, amountMinor: 1, paidOutOn: "2026-11-22", note: null });
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
  assert.equal(reloaded.canRecordCashReturned(person.id), true);
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
      assert.deepEqual(store.getSnapshot().records.people.map(row => row.id), [other.id]);
      assert.equal(await store.undo(removed.opId), true);
      assert.deepEqual(store.getSnapshot().records[collection], [record]);
      assert.deepEqual(store.getSnapshot().records.people, initial().people);
      assert.deepEqual(store.getSnapshot().pendingUndo, []);
    });
  }
});

test("undoing a refund deletion holds an invalid price change and its dependents", async () => {
  const { store, clock } = harness({ rules: ledger });
  await store.start();
  clock.online = false;
  const removal = await store.deleteRecord("refund", refund.id, token(store, refund));
  const reduction = await store.updateRecord("purchase", purchase.id, token(store, purchase), { totalMinor: 5 });
  const waiting = await store.createRecord("payment", payment());
  const independent = await store.createRecord("payment", payment(other.id));
  assert.equal(removal.status, "saved");
  assert.equal(reduction.status, "saved");
  assert.equal(waiting.status, "saved");
  assert.equal(independent.status, "saved");

  assert.equal(await store.undo(removal.opId), true);
  const { records, reviewItems } = store.getSnapshot();
  assert.deepEqual(records.refunds, [refund]);
  assert.deepEqual(records.purchases, [purchase]);
  assert.deepEqual(records.payments.map(row => row.id), [independent.recordId]);
  assert.equal(reviewItems[0].op.id, reduction.opId);
  assert.equal(reviewItems[0].code, "refunds_exceed_total");
  assert.match(reviewItems[0].reason, /undoing/i);
  assert.deepEqual(reviewItems[0].waiting.map(op => op.id), [waiting.opId]);
  const exported = await store.exportBackup();
  assert.equal(ledger.validateRecords(records, "2026-11-22"), null);
  assert.deepEqual(exported.unapplied.map(row => [row.op.id, row.dependencies]),
    [[reduction.opId, []], [waiting.opId, [reduction.opId]]]);
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
  const waiting = await store.createRecord("payment", payment(person.id));
  assert.equal(waiting.status, "saved");
  const independent = await store.createRecord("payment", payment(other.id));
  assert.equal(independent.status, "saved");
  const rejected = await store.createRecord("payout", { personId: other.id, amountMinor: 1, paidOutOn: "2026-11-22", note: null });
  assert.equal(rejected.status, "saved");
  clock.online = true;
  await store.syncNow();
  const current = store.getSnapshot();
  assert.equal(current.sync.pendingCount, 3);
  assert.deepEqual(current.records.payments.map(row => row.personId), [other.id]);
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

test("conflict review uses the latest snapshot and guards both actions against a stale display", async () => {
  const { store, clock, server, createAnother } = harness();
  const original = { ...payment(), id: "payment", version: "payment-v1" };
  const firstRemote = { ...original, version: "payment-v2", amountMinor: 200 };
  const latest = { ...original, version: "payment-v3", amountMinor: 300 };
  server.replace({ ...initial(), payments: [original] });
  await store.start();
  clock.online = false;
  const saved = await store.updateRecord("payment", original.id, token(store, original), { amountMinor: 150 });
  assert.equal(saved.status, "saved");
  server.replace({ ...server.snapshot, revision: 4, payments: [firstRemote] });
  server.result.decide = op => op.id === saved.opId
    ? { status: "conflict", code: "conflict", current: firstRemote } : undefined;
  clock.online = true;
  await store.syncNow();
  const [opened] = store.getSnapshot().reviewItems;
  assert.deepEqual(opened.server, firstRemote);

  server.replace({ ...server.snapshot, revision: 5, payments: [latest] });
  await createAnother().start();
  const staleServer = await store.keepServer(saved.opId);
  assert.deepEqual(staleServer, { status: "stale", current: latest, generation: initial().generation });
  const [current] = store.getSnapshot().reviewItems;
  assert.deepEqual(current.server, latest);
  const staleLocal = await store.keepLocal(saved.opId, opened);
  assert.deepEqual(staleLocal, staleServer);
  assert.deepEqual(await store.keepServer(saved.opId, opened), staleServer);
  assert.equal(server.operations.length, 1);
  assert.equal((await store.keepLocal(saved.opId, current)).status, "saved");
  await store.syncNow();
  const sent = server.operations.at(-1)?.items[0].op;
  assert.equal(sent?.kind === "update" && sent.baseVersion, latest.version);
  assert.equal(server.snapshot.payments[0].amountMinor, 150);
});

test("Keep mine restores the displayed payment owner and fields", async () => {
  const { store, clock, server } = harness();
  const original = { ...payment(), id: crypto.randomUUID(), version: "before" };
  server.replace({ ...initial(), payments: [original] });
  await store.start();
  clock.online = false;
  const saved = await store.updateRecord("payment", original.id, token(store, original), { amountMinor: 200 });
  assert.equal(saved.status, "saved");
  const remote = { ...original, version: "moved", personId: other.id, note: "Remote note" };
  server.replace({ ...server.snapshot, payments: [remote], revision: 4 });
  server.result.decide = op => op.id === saved.opId
    ? { status: "conflict", code: "conflict", current: remote } : undefined;
  clock.online = true;
  await store.syncNow();
  const [reviewed] = store.getSnapshot().reviewItems;
  assert.deepEqual(reviewed.local, { ...original, amountMinor: 200, version: saved.opId });
  assert.equal((await store.keepLocal(saved.opId, reviewed)).status, "saved");
  await store.syncNow();
  const sent = server.operations.at(-1)!.items[0].op;
  assert.deepEqual(sent.kind === "update" && [sent.baseVersion, sent.patch],
    [remote.version, { personId: person.id, amountMinor: 200, note: null }]);
  assert.deepEqual(server.snapshot.payments, [{ ...reviewed.local, version: sent.id }]);
});

test("confirming cash returned uses the displayed payout and rejects a stale review", async () => {
  const { store, clock, server, createAnother } = harness();
  const original = { id: crypto.randomUUID(), version: "payout-v1", personId: person.id,
    amountMinor: 1_000, paidOutOn: "2026-11-22", note: null };
  server.replace({ ...initial(), payouts: [original] });
  await store.start();
  clock.online = false;
  const saved = await store.updateRecord("payout", original.id, token(store, original), { amountMinor: 8_000 });
  assert.equal(saved.status, "saved");
  server.result.decide = op => op.id === saved.opId
    ? { status: "rejected", code: "payout_exceeds_credit", reason: "Above credit" } : undefined;
  clock.online = true;
  await store.syncNow();
  const [opened] = store.getSnapshot().reviewItems;
  const moved = { ...original, personId: other.id, note: "Moved", version: "payout-v2" };
  server.replace({ ...server.snapshot, payouts: [moved], revision: 4 });
  await createAnother().start();
  assert.deepEqual(await store.confirmAlreadyReturned(saved.opId, opened),
    { status: "stale", current: moved, generation: initial().generation });

  const [reviewed] = store.getSnapshot().reviewItems;
  assert.deepEqual(reviewed.local, { ...original, amountMinor: 8_000, version: saved.opId });
  assert.equal((await store.confirmAlreadyReturned(saved.opId, reviewed)).status, "saved");
  await store.syncNow();
  const sent = server.operations.at(-1)!.items[0].op;
  assert.equal(sent.alreadyReturned, true);
  assert.deepEqual(sent.kind === "update" && [sent.baseVersion, sent.patch],
    [moved.version, { personId: person.id, amountMinor: 8_000, note: null }]);
  assert.deepEqual(server.snapshot.payouts, [{ ...reviewed.local, version: sent.id }]);
});

test("held operations enter restore review and operations reflected by the new generation disappear", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  const applied = await store.createRecord("payment", payment(person.id));
  const held = await store.createRecord("payment", payment(other.id));
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

test("a held rename waits for the restored snapshot before it can be applied", async () => {
  const { store, clock, server } = harness();
  await store.start();
  clock.online = false;
  const earlier = await store.updateRecord("person", person.id, token(store, person), { name: "Earlier" });
  const rename = await store.updateRecord("person", person.id,
    token(store, store.getSnapshot().records.people[0]), { name: person.name });
  assert.equal(earlier.status, "saved");
  assert.equal(rename.status, "saved");
  server.result.decide = op => op.id === earlier.opId ? { status: "conflict", code: "conflict", current: person } : undefined;
  clock.online = true;
  await store.syncNow();
  clock.online = false;
  assert.equal((await store.discard(earlier.opId)).status, "saved");

  const restored = { ...person, name: "Restored", version: "restored-person" };
  server.replace({ ...initial(), people: [restored, other], generation: "new", revision: 4 });
  const requested = deferred<void>();
  const release = deferred<void>();
  server.hook.fetch = async path => {
    if (path === "/api/snapshot") {
      requested.resolve();
      await release.promise;
    }
    return undefined;
  };
  clock.online = true;
  const sync = store.syncNow();
  await requested.promise;
  try {
    const [waiting] = store.getSnapshot().reviewItems;
    assert.equal(store.getSnapshot().generation, initial().generation);
    assert.equal(store.getSnapshot().records.people[0].name, person.name);
    const result = await store.keepLocal(rename.opId, waiting);
    assert.equal(result.status, "invalid");
    assert.match(result.error.reason, /wait.*restored ledger/i);
    assert.equal(waiting.waitingForRestoredLedger, true);
    assert.deepEqual(store.getSnapshot().reviewItems.map(item => item.op.id), [rename.opId]);
  } finally {
    release.resolve();
    await sync;
  }

  const [ready] = store.getSnapshot().reviewItems;
  assert.equal(ready.waitingForRestoredLedger, false);
  assert.deepEqual(ready.server, restored);
  assert.equal((await store.editAndResubmit(rename.opId, {}, ready)).status, "invalid");
  assert.equal((await store.keepLocal(rename.opId, ready)).status, "saved");
  await store.syncNow();
  const sent = server.operations.at(-1)!.items[0].op;
  assert.deepEqual(sent.kind === "update" && [sent.generation, sent.baseVersion, sent.patch],
    ["new", restored.version, { name: person.name }]);
  assert.equal(server.snapshot.people[0].name, person.name);
  assert.deepEqual(store.getSnapshot().reviewItems, []);
});

test("a payout above restored credit can be confirmed as cash already returned", async t => {
  for (const resubmit of [false, true]) {
    await t.test(resubmit ? "edit and resubmit" : "apply to restored ledger", async () => {
      const { store, clock, server, createAnother } = harness({ rules: ledger });
      const paid = { ...payment(), id: crypto.randomUUID(), version: "paid", amountMinor: 490 };
      server.replace({ ...initial(), payments: [paid] });
      await store.start();
      assert.equal(store.getSnapshot().ledger?.balances[person.id].credit, 400);
      clock.online = false;
      const payout = { personId: person.id, amountMinor: 300, paidOutOn: "2026-11-22", note: null };
      const saved = await store.createRecord("payout", payout);
      assert.equal(saved.status, "saved");

      server.replace({ ...initial(), generation: "new", revision: 4 });
      clock.online = true;
      await store.syncNow();
      const [restored] = store.getSnapshot().reviewItems;
      assert.equal(restored.restore, true);
      const submitted = resubmit
        ? await store.editAndResubmit(saved.opId, { amountMinor: 250, note: "Edited" }, restored)
        : await store.keepLocal(saved.opId, restored);
      assert.equal(submitted.status, "invalid");
      assert.equal(submitted.error.code, "payout_exceeds_credit");
      assert.equal(store.getSnapshot().reviewItems[0].restore, false);

      const reopened = createAnother();
      await reopened.start();
      const [held] = reopened.getSnapshot().reviewItems;
      assert.equal(held.code, "payout_exceeds_credit");
      assert.equal(reviewActions(held).confirmPayout, true);
      assert.deepEqual(held.local, { ...payout, ...(resubmit ? { amountMinor: 250, note: "Edited" } : {}),
        id: saved.recordId, version: held.op.id });
      assert.deepEqual(reopened.getSnapshot().records.payouts, []);
      assert.equal(server.operations.length, 0);
      assert.equal((await reopened.confirmAlreadyReturned(held.op.id, held)).status, "saved");
      await reopened.syncNow();
      const sent = server.operations[0].items[0].op;
      assert.equal(sent.kind, "create");
      assert.equal(sent.generation, "new");
      assert.equal(sent.alreadyReturned, true);
      assert.notEqual(sent.id, held.op.id);
      assert.deepEqual(server.snapshot.payouts, [{ ...held.local, version: sent.id }]);
      assert.deepEqual(reopened.getSnapshot().reviewItems, []);
    });
  }
});

test("discarding an offline rename after another device restores leaves only the payday change", async () => {
  const { store, clock, server, rules } = harness();
  const mom = { ...person, name: "Mom" };
  server.replace({ ...initial(), people: [mom, other] });
  await store.start();
  const otherDevice = createStore({ dbName: crypto.randomUUID(), fetch: server.fetch, rules,
    online: () => true, automatic: false });
  await otherDevice.start();
  const file = await otherDevice.exportBackup();

  clock.online = false;
  const rename = await store.updateRecord("person", mom.id, token(store, mom), { name: "Discard me" });
  assert.equal(rename.status, "saved");
  const renamed = store.getSnapshot().records.people[0];
  const payday = await store.updateRecord("person", mom.id, token(store, renamed), { payday: 15 });
  assert.equal(payday.status, "saved");
  await otherDevice.commitRestore(await otherDevice.previewRestore(file));

  clock.online = true;
  await store.syncNow();
  assert.equal(server.operations.length, 0);
  assert.deepEqual(store.getSnapshot().reviewItems.map(item => [item.op.id, item.restore]),
    [[rename.opId, true], [payday.opId, true]]);
  assert.equal((await store.discard(rename.opId)).status, "saved");
  const [ready] = store.getSnapshot().reviewItems;
  assert.equal(ready.waitingOnEarlier, false);
  assert.deepEqual(ready.local, { ...mom, payday: 15, version: payday.opId });
  assert.equal((await store.keepLocal(payday.opId, ready)).status, "saved");
  await store.syncNow();
  const sent = server.operations[0].items[0].op;
  assert.deepEqual(sent.kind === "update" && [sent.baseVersion, sent.patch], [ready.server?.version, { payday: 15 }]);
  assert.deepEqual(server.snapshot.people[0], { ...mom, payday: 15, version: sent.id });
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
  const op: Operation = { id: crypto.randomUUID(), generation: original.generation, kind: "update", recordType: "person",
    recordId: person.id, createdAt: "2026-11-22T00:00:00Z", baseVersion: person.version, patch: { name: "New" } };
  const already: Operation = { ...op, id: crypto.randomUUID(), patch: { name: person.name } };
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
  const op: Operation = { id: crypto.randomUUID(), recordType: "person", recordId: person.id, kind: "update",
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

test("an imported settings create proposes its own time zone against restored settings", async () => {
  const { store, server } = harness({ rules: ledger });
  await store.start();
  const record = { id: "ledger", currency: "TRY", timeZone: "Europe/Istanbul" };
  const create: Operation = { id: crypto.randomUUID(), generation: initial().generation,
    createdAt: "2026-11-22T00:00:00Z", recordType: "settings", recordId: "ledger", kind: "create", record };
  const matchingRecord = { ...record, timeZone: "UTC" };
  const reflected: Operation = { ...create, id: crypto.randomUUID(), record: matchingRecord };
  const file = backup([
    { order: 0, op: reflected, dependencies: [], reason: null },
    { order: 1, op: create, dependencies: [], reason: "Settings already exist." },
  ]);
  await store.commitRestore(await store.previewRestore(file));

  const { reviewItems, records } = store.getSnapshot();
  assert.deepEqual(reviewItems.map(item => item.op.id), [create.id]);
  const [reviewed] = reviewItems;
  assert.equal(records.settings?.timeZone, "UTC");
  assert.deepEqual(reviewed.server, records.settings);
  assert.deepEqual(reviewed.local, { ...record, version: create.id });
  assert.equal((await store.keepLocal(create.id, reviewed)).status, "saved");
  await store.syncNow();
  const sent = server.operations[0].items[0].op;
  assert.deepEqual(sent.kind === "update" && [sent.baseVersion, sent.patch],
    [records.settings?.version, { timeZone: "Europe/Istanbul" }]);
  assert.deepEqual(server.snapshot.settings, { ...record, version: sent.id });
  assert.deepEqual(store.getSnapshot().reviewItems, []);
});

test("discarding a restore prerequisite leaves only the dependent payday change", async t => {
  for (const explicitDependency of [true, false]) {
    await t.test(explicitDependency ? "explicit dependency" : "earlier related change", async () => {
      const { store, server } = harness();
      await store.start();
      const rename: Operation = { id: crypto.randomUUID(), recordType: "person", recordId: person.id,
        kind: "update", baseVersion: person.version, generation: initial().generation,
        createdAt: "2026-11-22T00:00:00Z", patch: { name: "Discard me" } };
      const payday: Operation = { ...rename, id: crypto.randomUUID(), baseVersion: rename.id, patch: { payday: 15 } };
      const file = backup([
        { order: 0, op: rename, dependencies: [], reason: "Review the name" },
        { order: 1, op: payday, dependencies: explicitDependency ? [rename.id] : [], reason: null },
      ]);
      await store.commitRestore(await store.previewRestore(file));
      const [first, waiting] = store.getSnapshot().reviewItems;
      assert.deepEqual(first.waiting.map(op => op.id), [payday.id]);
      assert.equal(waiting.waitingOnEarlier, true);
      assert.equal((await store.keepLocal(payday.id, waiting)).status, "invalid");
      assert.equal((await store.editAndResubmit(payday.id, { payday: 15 }, waiting)).status, "invalid");
      await store.syncNow();
      assert.equal(server.operations.length, 0);

      assert.equal((await store.discard(rename.id)).status, "saved");
      const [ready] = store.getSnapshot().reviewItems;
      assert.equal(ready.waitingOnEarlier, false);
      assert.deepEqual(ready.local, { ...person, payday: 15, version: payday.id });
      assert.equal((await store.keepLocal(payday.id, ready)).status, "saved");
      await store.syncNow();
      const sent = server.operations[0].items[0].op;
      assert.deepEqual(sent.kind === "update" && sent.patch, { payday: 15 });
      assert.deepEqual(server.snapshot.people[0], { ...person, payday: 15, version: sent.id });
    });
  }
});

test("a definitive restore rejection clears pending state and allows another restore", async t => {
  for (const response of [
    () => Response.json({ error: "invalid", message: "Bad backup request." }, { status: 400 }),
    () => Response.json({ status: "rejected", code: "invalid", reason: "Bad backup data." }),
  ]) {
    await t.test(String(response().status), async () => {
      const { store, server, dbName } = harness();
      await store.start();
      const preview = await store.previewRestore(backup());
      server.hook.fetch = async path => path === "/api/restore" ? response() : undefined;
      await assert.rejects(store.commitRestore(preview), /Bad backup/);
      assert.match(store.getSnapshot().sync.lastError ?? "", /Bad backup/);
      assert.equal(store.getSnapshot().sync.restoreInProgress, false);
      assert.equal((await readLocal(await openLedger(dbName))).meta.restore, undefined);
      await store.syncNow();
      assert.equal(server.calls.filter(call => call.path === "/api/restore").length, 1);
      server.hook.fetch = undefined;
      await store.commitRestore(await store.previewRestore(backup()));
      assert.equal(server.snapshot.revision, preview.revision + 1);
    });
  }
});

test("an unauthorized restore keeps its request for retry after sign-in", async () => {
  const { store, server } = harness();
  await store.start();
  const preview = await store.previewRestore(backup());
  server.hook.fetch = async path => path === "/api/restore" ? new Response(null, { status: 401 }) : undefined;
  await assert.rejects(store.commitRestore(preview), /Sign in/);
  assert.equal(store.getSnapshot().sync.needsSignIn, true);
  assert.equal(store.getSnapshot().sync.restoreInProgress, false);
  server.hook.fetch = undefined;
  await store.syncNow();
  const requests = server.calls.filter(call => call.path === "/api/restore");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(server.snapshot.revision, preview.revision + 1);
});

test("restore preview rejects a malformed payment patch and legacy review data stays readable", async () => {
  const { store, server, dbName } = harness();
  const record = { ...payment(), id: crypto.randomUUID(), version: "initial-payment" };
  server.replace({ ...initial(), payments: [record] });
  await store.start();
  const op: Operation = {
    id: crypto.randomUUID(), generation: initial().generation, recordType: "payment", recordId: record.id,
    createdAt: "2026-11-22T00:00:00Z", kind: "update", baseVersion: record.version, patch: { paidOn: 123 },
  };
  const file = backup([{ order: 0, op, dependencies: [], reason: null }]);
  await assert.rejects(store.previewRestore(file), /unapplied operation 1.*patch/i);
  assert.equal(server.calls.some(call => call.path === "/api/restore"), false);

  const db = await openLedger(dbName);
  await changeLocal(db, undefined, state => {
    state.queue.push({ op, order: 0, people: [person.id], state: "needsReview", restore: true,
      reason: "From an older restore", local: { ...record, paidOn: 123 } as unknown as typeof record });
  });
  await store.refreshLocal();
  assert.equal(store.getSnapshot().reviewItems[0].waitingForRestoredLedger, true);
  await store.syncNow();
  const [item] = store.getSnapshot().reviewItems;
  assert.equal(item.local, null);
  assert.deepEqual(item.server, record);
  assert.equal((await store.keepLocal(op.id, item)).status, "invalid");
  assert.equal((await store.editAndResubmit(op.id, { paidOn: "2026-11-21" }, item)).status, "saved");
  await store.syncNow();
  assert.equal(server.snapshot.payments[0].paidOn, "2026-11-21");
});

test("an interrupted restore releases saves and recovers unapplied work using its receipt", async () => {
  const { store, server } = harness();
  await store.start();
  const op: Operation = { id: crypto.randomUUID(), recordType: "person", recordId: person.id, kind: "update",
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

test("reconnecting retries a restore that never reached the server with the original operation ID", async () => {
  const { store, server, clock, createAnother } = harness();
  await store.start();
  const op: Operation = { id: crypto.randomUUID(), recordType: "person", recordId: person.id, kind: "update",
    baseVersion: person.version, generation: initial().generation, createdAt: "2026-11-22T00:00:00Z",
    patch: { name: "From backup" } };
  const preview = await store.previewRestore(backup([{ order: 0, op, dependencies: [], reason: null }]));
  server.hook.fetch = async path => {
    if (path === "/api/restore") {
      clock.online = false;
      throw new TypeError("Disconnected before sending");
    }
    return undefined;
  };
  await assert.rejects(store.commitRestore(preview), /Could not reach/);
  assert.equal(store.getSnapshot().sync.restoreInProgress, false);
  assert.equal(server.snapshot.revision, preview.revision);

  server.hook.fetch = undefined;
  clock.online = true;
  const reloaded = createAnother();
  await reloaded.start();
  const attempts = server.calls.filter(call => call.path === "/api/restore").map(call => call.body as RestoreRequest);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(server.snapshot.revision, preview.revision + 1);
  assert.equal(reloaded.getSnapshot().sync.restoreInProgress, false);
  assert.deepEqual(reloaded.getSnapshot().reviewItems.map(row => row.op.id), [op.id]);
  await reloaded.discard(op.id);
  await reloaded.commitRestore(await reloaded.previewRestore(backup()));
});

test("sync bounds request bytes and item count and keeps earlier batches after a disconnect", async () => {
  const { store, clock, server, dbName } = harness();
  await store.start();
  clock.online = false;
  const db = await openLedger(dbName);
  const large = payment();
  large.note = "🧾".repeat(500);
  const ids: string[] = Array.from({ length: 920 }, () => crypto.randomUUID());
  await changeLocal(db, undefined, state => {
    for (const [index, id] of ids.entries()) {
      const fields = index < 700 ? large : payment(other.id);
      const op: Operation = { kind: "create", recordType: "payment", id, recordId: id,
        generation: initial().generation, createdAt: "2026-11-22T00:00:00Z", record: { ...fields, id } };
      state.queue.push({ state: "sendable", op, order: index, people: [fields.personId],
        local: { ...fields, id, version: id } });
    }
  });

  const posted: string[][] = [];
  let rejection: string | undefined;
  server.result.decide = op => op.id === rejection ? { status: "rejected", code: "invalid" } : undefined;
  server.hook.fetch = async path => {
    if (path !== "/api/sync/ops") return undefined;
    const body = server.calls.at(-1)!.body as (typeof server.operations)[number];
    const bytes = Buffer.byteLength(JSON.stringify(body));
    if (bytes > 8 * 1024 * 1024) return Response.json({ error: "body_too_large" }, { status: 413 });
    assert.ok(bytes <= 1024 * 1024);
    assert.ok(body.items.length <= 200);
    const selected = new Set<string>();
    for (const { op, deps } of body.items) {
      assert.ok(deps.every(dep => selected.has(dep) || server.receipts.get(dep)?.status === "applied"));
      selected.add(op.id);
    }
    posted.push([...selected]);
    if (posted.length === 2) throw new TypeError("Disconnected during second batch");
    if (posted.length === 3) rejection = body.items.at(-1)!.op.id;
    return undefined;
  };

  clock.online = true;
  await store.syncNow();
  assert.equal(posted.length, 2);
  assert.ok(posted[0].length < 200, "UTF-8 byte limit splits the first batch");
  assert.deepEqual(posted[0], ids.slice(0, posted[0].length));
  assert.deepEqual(server.snapshot.payments.map(row => row.id), posted[0]);
  assert.deepEqual((await readLocal(db)).queue.filter(row => row.state === "acked").map(row => row.op.id), posted[0]);
  assert.match(store.getSnapshot().sync.lastError ?? "", /Could not reach/);

  await store.syncNow();
  assert.deepEqual(posted[2], posted[1]);
  assert.deepEqual(posted[2], ids.slice(posted[0].length, posted[0].length + posted[2].length));
  assert.ok(rejection);
  assert.deepEqual(posted.slice(3).flat(), ids.slice(700));
  assert.equal(posted[3].length, 200);
  assert.equal(store.getSnapshot().sync.lastError, null);
  assert.equal(store.getSnapshot().reviewItems[0].op.id, rejection);
  assert.equal(store.getSnapshot().reviewItems[0].waiting.length, 699 - ids.indexOf(rejection));
  assert.equal(server.snapshot.payments.length, posted[0].length + posted[2].length - 1 + 220);
});

test("a second restore preserves unapplied work when the first commits after a missing receipt", async () => {
  const { store, server } = harness();
  await store.start();
  const op: Operation = { id: crypto.randomUUID(), recordType: "person", recordId: person.id, kind: "update",
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
