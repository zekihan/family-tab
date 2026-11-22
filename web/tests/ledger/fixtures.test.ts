import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  computeLedger, defaultInstallmentStart, dueShortcuts, normalizeName, parseAmount, paymentChips, validateChange,
  validateRecords,
} from "../../src/ledger/index.ts";
import type { PurchaseView } from "../../src/ledger/index.ts";
import type {
  ComingUpEntry, HomeTotals, Operation, PaymentChip, PersonBalance, ReceiptCode, Records, ScheduledAmount, StatusChip,
} from "../../src/types.ts";

interface BaseFixture {
  name: string;
  description: string;
  timeZone: string;
  today: string;
  records: Omit<Records, "settings">;
}

interface LedgerFixture extends BaseFixture {
  expect: {
    valid?: true | { code: ReceiptCode };
    schedules?: Record<string, ScheduledAmount[]>;
    people?: Record<string, Partial<PersonBalance>>;
    home?: Partial<HomeTotals>;
    homeOrder?: string[];
    purchases?: Record<string, Partial<PurchaseView>>;
    comingUp?: ComingUpEntry[];
    chips?: Record<string, StatusChip>;
    paymentChips?: Record<string, PaymentChip[]>;
  };
}

interface ChangeFixture extends BaseFixture {
  op: Operation;
  expect: { status: "applied" } | { status: "rejected"; code: ReceiptCode };
}

const testdata = new URL("../../../testdata/", import.meta.url);

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, testdata), "utf8")) as T;
}

function fixtureFiles(directory: string): string[] {
  return readdirSync(new URL(directory, testdata)).filter(file => file.endsWith(".json")).sort();
}

// Fixtures may omit `aliases` (default []) and `source` (default "app").
function withDefaults<T extends object>(record: T, source: boolean): T {
  return {
    ...("name" in record ? { aliases: [] } : {}), ...(source && !("name" in record) ? { source: "app" } : {}), ...record,
  };
}

function fixtureRecords(fixture: BaseFixture): Records {
  const { people, purchases, payments, refunds, payouts } = fixture.records;
  return {
    people: people.map(row => withDefaults(row, false)),
    purchases: purchases.map(row => withDefaults(row, true)),
    payments: payments.map(row => withDefaults(row, true)),
    refunds: refunds.map(row => withDefaults(row, true)),
    payouts,
    settings: { id: "ledger", timeZone: fixture.timeZone, currency: "TRY", version: "fixture" },
  };
}

function fixtureOperation(op: Operation): Operation {
  const source = op.recordType === "purchase" || op.recordType === "payment" || op.recordType === "refund";
  if (op.kind === "create") return { ...op, record: withDefaults(op.record, false) };
  if (op.kind === "delete") return { ...op, preImage: withDefaults(op.preImage, source) };
  return op;
}

const collectionByType = {
  person: "people",
  purchase: "purchases",
  payment: "payments",
  refund: "refunds",
  payout: "payouts",
} as const;

function applyForTest(before: Records, op: Operation): Records {
  const { recordId, recordType, kind } = op;
  if (recordType === "settings") {
    switch (kind) {
      case "create":
        return { ...before, settings: { ...op.record, version: op.id } as Records["settings"] };
      case "update":
        assert.ok(before.settings);
        return { ...before, settings: { ...before.settings, ...op.patch, version: op.id } };
      case "delete":
        return { ...before, settings: null };
    }
  }

  const collection = collectionByType[recordType];
  const existing = before[collection];
  switch (kind) {
    case "create":
      return { ...before, [collection]: [...existing, { ...op.record, version: op.id }] };
    case "update":
      return {
        ...before,
        [collection]: existing.map(record => record.id === recordId ? { ...record, ...op.patch, version: op.id } : record),
      };
    case "delete":
      return { ...before, [collection]: existing.filter(record => record.id !== recordId) };
  }
}

for (const file of fixtureFiles("ledger/")) {
  const fixture = readJSON<LedgerFixture>(`ledger/${file}`);
  test(`ledger/${file} — ${fixture.description}`, () => {
    const records = fixtureRecords(fixture);
    const { expect, today } = fixture;
    if (expect.valid === true) {
      assert.equal(validateRecords(records, today), null);
    } else if (expect.valid) {
      assert.equal(validateRecords(records, today)?.code, expect.valid.code);
    }

    if (!Object.keys(expect).some(key => key !== "valid")) return;
    const view = computeLedger(records, today);
    for (const [key, expected] of Object.entries(expect)) {
      switch (key) {
        case "valid":
          break;
        case "schedules":
          for (const [id, schedule] of Object.entries(expect.schedules!)) {
            assert.deepEqual(view.purchases[id]?.adjusted, schedule, id);
          }
          break;
        case "people":
          assert.partialDeepStrictEqual(view.balances, expected);
          break;
        case "home":
          assert.partialDeepStrictEqual(view.home, expected);
          break;
        case "homeOrder":
          assert.deepEqual(view.homeOrder, expected);
          break;
        case "purchases":
          for (const [id, detail] of Object.entries(expect.purchases!)) {
            assert.ok(Object.hasOwn(view.purchases, id), id);
            for (const field of Object.keys(detail) as (keyof PurchaseView)[]) {
              assert.deepEqual(view.purchases[id][field], detail[field], `${id}.${field}`);
            }
          }
          break;
        case "comingUp":
          assert.deepEqual(view.comingUp, expected);
          break;
        case "chips":
          for (const [id, chip] of Object.entries(expect.chips!)) {
            assert.deepEqual(view.chips[id], chip, id);
          }
          break;
        case "paymentChips":
          for (const [id, chips] of Object.entries(expect.paymentChips!)) {
            assert.deepEqual(paymentChips(view, records, id), chips, id);
          }
          break;
        default:
          assert.fail(`Unknown fixture expectation: ${key}`);
      }
    }
  });
}

for (const { input, minor } of readJSON<{ input: string; minor: number | null }[]>("amounts.json")) {
  test(`amounts.json — ${JSON.stringify(input)}`, () => {
    const result = parseAmount(input);
    assert.equal(result.ok ? result.minor : null, minor);
  });
}

const defaultsFixtures = readJSON<{
  today: string;
  payday: number | null;
  shortcuts: ReturnType<typeof dueShortcuts>;
  installmentStart: ReturnType<typeof defaultInstallmentStart>;
}[]>("defaults.json");
assert.ok(defaultsFixtures.length >= 15);
for (const { today, payday, shortcuts, installmentStart } of defaultsFixtures) {
  test(`defaults.json — ${today} payday ${payday}`, () => {
    assert.deepEqual(dueShortcuts(today, payday), shortcuts);
    assert.deepEqual(defaultInstallmentStart(today, payday), installmentStart);
  });
}

for (const { input, normalized } of readJSON<{ input: string; normalized: string }[]>("names.json")) {
  test(`names.json — ${JSON.stringify(input)}`, () => {
    assert.equal(normalizeName(input), normalized);
  });
}

for (const file of fixtureFiles("changes/")) {
  const fixture = readJSON<ChangeFixture>(`changes/${file}`);
  const wireOnly = fixture.op.kind === "create" && Object.hasOwn(fixture.op.record, "source");
  test(`changes/${file} — ${fixture.description}`, { skip: wireOnly && "the server rejects source in a create record" }, () => {
    const before = fixtureRecords(fixture);
    const op = fixtureOperation(fixture.op);
    const after = applyForTest(before, op);
    const error = validateChange(before, after, op, fixture.today);
    assert.deepEqual(
      error ? { status: "rejected", code: error.code } : { status: "applied" },
      fixture.expect,
      error?.reason,
    );
  });
}
