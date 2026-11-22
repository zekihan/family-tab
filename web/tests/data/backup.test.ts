import assert from "node:assert/strict";
import test from "node:test";
import { parseBackup } from "../../src/data/backup.ts";
import type { Operation } from "../../src/types.ts";
import { backup, payment, person, refund } from "./helpers.ts";

const stored = { ...payment(), id: "00000000-0000-4000-8000-000000000005" };
const { source: _source, ...cash } = stored;
const create = {
  id: "00000000-0000-4000-8000-000000000006", generation: "before-restore",
  createdAt: "2026-11-22T12:00:00.123Z", kind: "create", recordType: "payment", recordId: cash.id, record: cash,
} satisfies Operation;
const update = {
  id: "00000000-0000-4000-8000-000000000007", generation: create.generation,
  createdAt: create.createdAt, kind: "update", recordType: "payment", recordId: cash.id,
  baseVersion: create.id, patch: { amountMinor: 200, note: null },
} satisfies Operation;
const remove = {
  id: "00000000-0000-4000-8000-000000000008", generation: create.generation,
  createdAt: create.createdAt, kind: "delete", recordType: "payment", recordId: cash.id,
  baseVersion: update.id, preImage: { ...stored, amountMinor: 200, version: update.id },
} satisfies Operation;
const entry = { order: 0, dependencies: [], reason: null, op: create };

test("parseBackup accepts exact operation payloads and earlier dependencies", () => {
  const file = backup([
    entry,
    { order: 1, dependencies: [create.id], reason: "Server rejected it", op: update },
    { order: 2, dependencies: [update.id], reason: null, op: remove },
  ]);
  const { version: _version, ...unversioned } = file.people[0];
  const json = JSON.stringify({ ...file, people: [unversioned, file.people[1]] });
  assert.deepEqual(parseBackup(json), JSON.parse(json));
});

test("parseBackup rejects unknown fields at every backup level", () => {
  assert.throws(() => parseBackup({ ...backup(), extra: 1 }), /invalid.*backup/i);
  const { people: _people, ...withoutPeople } = backup();
  assert.throws(() => parseBackup(withoutPeople), /people/i);
  assert.throws(() => parseBackup({ ...backup(), people: [{ ...person, extra: 1 }] }), /people/i);
  const { aliases: _aliases, ...withoutAliases } = person;
  assert.throws(() => parseBackup({ ...backup(), people: [withoutAliases] }), /people/i);
  const { source: _stored, ...unsourced } = refund;
  assert.throws(() => parseBackup({ ...backup(), refunds: [unsourced] }), /refunds/i);
  assert.throws(() => parseBackup({ ...backup(), refunds: [{ ...refund, source: "mcp" }] }), /refunds/i);
  for (const item of [
    { ...entry, extra: 1 },
    { ...entry, op: { ...create, extra: 1 } },
    { ...entry, op: { ...create, record: { ...cash, extra: 1 } } },
    { ...entry, op: { ...update, patch: { extra: 1 } } },
    { ...entry, op: { ...remove, preImage: { ...remove.preImage, extra: 1 } } },
  ]) {
    assert.throws(() => parseBackup({ ...backup(), unapplied: [item] }), /unapplied operation 1/i);
  }
});

test("parseBackup rejects malformed unapplied operations and dependencies", () => {
  const invalid = [
    [{ ...entry, order: 0.5 }, /order/],
    [{ ...entry, reason: 0 }, /reason/],
    [{ ...entry, dependencies: [update.id] }, /earlier/],
    [{ ...entry, dependencies: [create.id] }, /earlier/],
    [{ ...entry, dependencies: [1] }, /earlier/],
    [{ ...entry, op: { ...create, createdAt: "today" } }, /metadata/],
    [{ ...entry, op: { ...create, id: "bad", generation: "" } }, /metadata/],
    [{ ...entry, op: { ...create, record: { ...cash, note: undefined } } }, /record/],
    [{ ...entry, op: { ...create, record: { ...cash, id: person.id } } }, /record/],
    [{ ...entry, op: { ...create, alreadyReturned: false } }, /alreadyReturned/],
    [{ ...entry, op: { ...update, patch: { paidOn: 123 } } }, /patch/],
    [{ ...entry, op: { ...update, patch: { amountMinor: 0.5 } } }, /patch/],
    [{ ...entry, op: { ...update, patch: { personId: null } } }, /patch/],
    [{ ...entry, op: { ...update, patch: { id: cash.id } } }, /patch/],
    [{ ...entry, op: { ...update, recordType: "refund", recordId: refund.id,
      patch: { purchaseId: refund.purchaseId } } }, /patch/],
    [{ ...entry, op: { ...update, recordType: "settings", recordId: "ledger",
      patch: { currency: "TRY" } } }, /patch/],
    [{ ...entry, op: { ...update, baseVersion: null } }, /baseVersion/],
    [{ ...entry, op: { ...remove, preImage: { ...remove.preImage, version: create.id } } }, /preImage/],
    [{ ...entry, op: { ...remove, preImage: { ...remove.preImage, paidOn: null } } }, /preImage/],
    [{ ...entry, op: { ...create, record: stored } }, /record/],
    [{ ...entry, op: { ...update, patch: { source: "agent" } } }, /patch/],
    [{ ...entry, op: { ...remove, preImage: { ...cash, version: update.id } } }, /preImage/],
    [{ ...entry, op: { ...remove, preImage: { ...remove.preImage, source: "mcp" } } }, /preImage/],
    [{ ...entry, op: { ...update, recordType: "person", recordId: person.id, patch: { aliases: "Anne" } } }, /patch/],
    [{ ...entry, op: { ...update, recordType: "person", recordId: person.id, patch: { aliases: [1] } } }, /patch/],
  ] as const;
  for (const [row, message] of invalid) {
    assert.throws(() => parseBackup({ ...backup(), unapplied: [row] }), message);
  }
  assert.throws(() => parseBackup({ ...backup(), unapplied: [entry, entry] }), /duplicate operation ID/);
  assert.throws(() => parseBackup({ ...backup(), unapplied: [
    { ...entry, dependencies: [update.id] }, { ...entry, order: 1, op: update },
  ] }), /earlier unapplied operation/);
});
