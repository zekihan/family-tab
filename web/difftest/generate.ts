import { addDays } from "../src/ledger/index.ts";
import type { LedgerRecord, Operation, Purchase, Records, RecordType } from "../src/types.ts";

export interface LedgerCase {
  today: string;
  timeZone: string;
  records: Omit<Records, "settings">;
  changes: { op: Operation }[];
  amounts: string[];
}

class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  int(min: number, max: number): number {
    // Mulberry32, with explicit 32-bit arithmetic so a logged seed is reproducible.
    this.state = (this.state + 0x6d2b79f5) | 0;
    let bits = Math.imul(this.state ^ (this.state >>> 15), this.state | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return min + Math.floor(((bits ^ (bits >>> 14)) >>> 0) / 0x100000000 * (max - min + 1));
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(0, values.length - 1)];
  }
}

// Each row gives a month end and the next month end, independently of schedule code.
const monthEnds = [
  ["2023-01-31", "2023-02-28"],
  ["2024-01-31", "2024-02-29"],
  ["2024-02-29", "2024-03-31"],
  ["2024-03-31", "2024-04-30"],
  ["2024-12-31", "2025-01-31"],
  ["2025-02-28", "2025-03-31"],
  ["2100-01-31", "2100-02-28"],
];

const version = "fixture";

function firstDue(monthEnd: string, dueDay: number): string {
  const day = Math.min(Number(monthEnd.slice(8)), dueDay);
  return monthEnd.slice(0, 8) + String(day).padStart(2, "0");
}

function amountInputs(random: Random): string[] {
  const alphabet = "0123456789.,  ";
  const noise = () => Array.from({ length: random.int(0, 21) }, () => alphabet[random.int(0, alphabet.length - 1)]).join("");
  const whole = random.pick([random.int(0, 9999), random.int(99_999_998, 100_000_002)]);
  const fraction = String(random.int(0, 99)).padStart(2, "0");
  const thousands = String(random.int(0, 999)).padStart(3, "0");
  return [
    noise(), noise(), noise(), String(whole), ` ${whole}${random.pick([".", ","])}${fraction} `,
    `${random.int(1, 999)}.${thousands},${fraction}`, `${random.int(1, 999)},${thousands}`,
    `${random.int(1, 999)},${thousands}. `, `0.${thousands}`,
  ];
}

function changesFor(random: Random, records: LedgerCase["records"], today: string): LedgerCase["changes"] {
  const person = random.pick(records.people);
  const purchase = random.pick(records.purchases);
  const payment = random.pick(records.payments);
  const refund = random.pick(records.refunds);
  const payout = random.pick(records.payouts);
  const refundedPurchase = records.purchases.find(row => row.id === refund.purchaseId)!;

  const base = (kind: Operation["kind"], recordType: RecordType, recordId: string) => ({
    id: `operation-${kind}-${recordType}-${recordId}`,
    generation: "fixture",
    createdAt: `${today}T12:00:00Z`,
    recordType,
    recordId,
  });
  const create = (recordType: RecordType, row: LedgerRecord, alreadyReturned?: boolean): Operation => {
    const { version: _version, ...record } = row;
    return { ...base("create", recordType, row.id), kind: "create", record, alreadyReturned };
  };
  const update = (recordType: RecordType, row: LedgerRecord, patch: Record<string, unknown>): Operation => ({
    ...base("update", recordType, row.id), kind: "update", baseVersion: row.version, patch,
  });
  const remove = (recordType: RecordType, row: LedgerRecord): Operation => ({
    ...base("delete", recordType, row.id), kind: "delete", baseVersion: row.version, preImage: row,
  });

  const ops = [
    create("person", { ...person, id: random.pick(["new-person", purchase.id]), payday: random.pick([null, 31, 32]) }),
    create("purchase", { ...purchase, id: "new-purchase", personId: random.pick([person.id, purchase.personId, "missing"]) }),
    create("refund", {
      ...refund, id: "new-refund", purchaseId: refundedPurchase.id, refundedOn: today,
      amountMinor: random.pick([1, refundedPurchase.totalMinor]),
    }),
    create("payout", {
      ...payout, id: "new-payout", personId: person.id, paidOutOn: today,
      amountMinor: random.pick([1, 100_001]),
    }, random.int(0, 4) === 0),
    update("person", person, { payday: random.pick([null, 1, 31, 32]), archived: !person.archived }),
    update("purchase", purchase, random.pick([
      { personId: person.id },
      { boughtOn: addDays(today, 1) },
      { totalMinor: random.int(1, purchase.totalMinor) },
      { note: null },
    ])),
    update("payment", payment, random.pick([{ paidOn: addDays(today, 1) }, { amountMinor: 1 }, { note: null }])),
    update("refund", refund, { amountMinor: random.pick([1, 100_001]) }),
    update("payout", payout, random.pick([{ personId: person.id }, { amountMinor: 1 }, { amountMinor: 100_001 }])),
    remove("person", person),
    remove("purchase", purchase),
    random.pick([remove("payment", payment), remove("refund", refund), remove("payout", payout)]),
  ];
  return ops.map(op => ({ op }));
}

function generateCase(random: Random): LedgerCase {
  const [endOfMonth, nextEndOfMonth] = random.pick(monthEnds);
  const today = addDays(endOfMonth, random.int(-1, 1));
  const timeZone = random.pick(["UTC", "Europe/Istanbul", "America/New_York", "Pacific/Auckland"]);
  const people: Records["people"] = Array.from({ length: random.int(2, 6) }, (_, i) => ({
    id: `person-${i}`, name: `Kişi ${i}`, version, archived: random.int(0, 3) === 0,
    payday: random.pick([null, 1, 15, 29, 30, 31]),
  }));
  const purchases: Purchase[] = Array.from({ length: random.int(2, 7) }, (_, i) => {
    const dueDay = random.pick([1, 15, 28, 29, 30, 31, 31]);
    const plan = i === 0 ? "once" : i === 1 ? "installments" : random.pick(["once", "installments"] as const);
    return {
      id: `purchase-${i}`, personId: random.pick(people).id, item: `Ürün ${i}`, version, note: null,
      totalMinor: random.pick([random.int(120, 30_000), 10_000_000_000]),
      boughtOn: addDays(endOfMonth, -random.int(31, 45)),
      plan,
      dueDate: plan === "once" ? random.pick([null, addDays(today, -1), today, addDays(today, 1), nextEndOfMonth]) : null,
      count: plan === "installments" ? random.pick([2, 120, random.int(3, 18)]) : null,
      dueDay: plan === "installments" ? dueDay : null,
      firstDue: plan === "installments" ? firstDue(random.pick([endOfMonth, nextEndOfMonth]), dueDay) : null,
    };
  });

  const refunds: Records["refunds"] = [];
  for (const [i, purchase] of purchases.entries()) {
    if (i !== 0 && random.int(0, 3) === 0) continue;
    const total = random.pick([random.int(1, purchase.totalMinor), purchase.totalMinor]);
    const first = random.pick([random.int(1, total), total]);
    const addRefund = (amountMinor: number) => refunds.push({
      id: `refund-${refunds.length}`, purchaseId: purchase.id, amountMinor, version, note: null,
      refundedOn: random.pick([purchase.boughtOn, addDays(today, -1), today]),
    });
    addRefund(first);
    if (total > first) addRefund(total - first);
  }

  const payments: Records["payments"] = Array.from({ length: random.int(1, 8) }, (_, i) => ({
    id: `payment-${i}`, personId: random.pick(people).id, amountMinor: random.int(1, 45_000), version, note: "cash",
    paidOn: addDays(today, random.pick([-2, -1, 0, 0, ...(i === 0 ? [1] : [])])),
  }));
  const payouts: Records["payouts"] = Array.from({ length: random.int(1, 5) }, (_, i) => ({
    id: `payout-${i}`, personId: random.pick(people).id, amountMinor: random.int(1, 50_000), version, note: null,
    paidOutOn: addDays(today, random.int(-2, 0)),
  }));

  const records = { people, purchases, payments, refunds, payouts };
  return { today, timeZone, records, changes: changesFor(random, records, today), amounts: amountInputs(random) };
}

export function generateCases(seed: number, count: number): LedgerCase[] {
  const random = new Random(seed);
  return Array.from({ length: count }, () => generateCase(random));
}
