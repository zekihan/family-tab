import assert from "node:assert/strict";
import test from "node:test";
import { affectedPeople, applyOperation, reflects, replay } from "../../src/data/model.ts";
import type { QueueEntry } from "../../src/data/model.ts";
import type { Operation } from "../../src/types.ts";
import { initial, other, payment, person, purchase, refund } from "./helpers.ts";

const common = { generation: initial().generation, createdAt: "2026-11-22T00:00:00Z" };
const move: Operation = { ...common, id: "move", recordId: purchase.id, recordType: "purchase", kind: "update",
  baseVersion: purchase.version, patch: { personId: other.id, note: null } };
const removeRefund: Operation = { ...common, id: "remove-refund", recordId: refund.id, recordType: "refund",
  kind: "delete", baseVersion: refund.version, preImage: refund };

function row(order: number, op: Operation, state: Partial<QueueEntry> = {}): QueueEntry {
  return {
    order, op, local: null, people: affectedPeople(initial(), op), state: "sendable", ...state,
  } as QueueEntry;
}

test("applyOperation changes only patchable fields and uses the operation ID as the record version", () => {
  const records = initial();
  const created = applyOperation(records, { ...common, kind: "create", id: "create", recordId: "payment",
    recordType: "payment", record: { id: "payment", ...payment() } });
  assert.deepEqual(created.payments, [{ ...payment(), id: "payment", version: "create" }]);
  const moved = applyOperation(created, { ...move, patch: { ...move.patch, id: "wrong", version: "wrong" } });
  assert.deepEqual(moved.purchases, [{ ...purchase, personId: other.id, version: move.id }]);
  assert.equal(moved.refunds[0].purchaseId, purchase.id);
  assert.equal(records.purchases[0].version, purchase.version);
  const patch = { ...common, id: "update-refund", recordType: "refund", recordId: refund.id,
    kind: "update", baseVersion: refund.version, patch: { purchaseId: "wrong", note: "Changed" } } as const;
  assert.deepEqual(applyOperation(moved, patch).refunds, [{ ...refund, note: "Changed", version: patch.id }]);
  assert.deepEqual(applyOperation(moved, removeRefund).refunds, []);
  assert.equal(reflects(moved, move), true);
});

test("queue deps account for moves, refunds, person creates and independent settings", () => {
  const create: Operation = { ...common, id: "create-person", kind: "create",
    recordType: "person", recordId: other.id, record: { ...person, id: other.id } };
  const settings: Operation = { ...common, id: "settings", kind: "update",
    recordType: "settings", recordId: "ledger", baseVersion: "setup", patch: { timeZone: "Europe/Istanbul" } };
  const queue = [row(1, create), row(2, move), row(3, removeRefund), row(4, settings)];
  const items = replay(initial(), queue, 10).items;
  assert.deepEqual(items.map(item => item.deps), [[], [create.id], [create.id, move.id], []]);
  queue[1] = row(2, move, { state: "needsReview", reason: "Conflict" });
  const view = replay(initial(), queue, 10);
  assert.deepEqual(view.excluded.map(item => item.op.id), [move.id, removeRefund.id]);
  assert.equal(view.records.refunds.length, 1);
  assert.equal(view.records.purchases[0].personId, person.id);
  assert.deepEqual(view.items.map(item => item.op.id), [create.id, settings.id]);
});

test("pending undo is replayed but holds related operations until the deadline", () => {
  const queue = [row(1, removeRefund, { state: "pendingUndo", deadline: 10 }), row(2, move)];
  const beforeDeadline = replay(initial(), queue, 9);
  assert.equal(beforeDeadline.records.refunds.length, 0);
  assert.deepEqual(beforeDeadline.items, []);
  assert.deepEqual(replay(initial(), queue, 10).items.map(item => item.deps), [[], [removeRefund.id]]);
});
