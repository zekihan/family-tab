import { isDeepStrictEqual } from "node:util";
import { calculate } from "./calculate.ts";
import type { Result } from "./calculate.ts";
import type { LedgerCase } from "./generate.ts";
import type { PurchaseView } from "../src/ledger/index.ts";
import type { ComingUpEntry, HomeTotals, PaymentChip, PersonBalance, StatusChip } from "../src/types.ts";

type Path = (string | number)[];

interface Difference {
  path: Path;
  go: unknown;
  ts: unknown;
}

export interface Mismatch {
  input: LedgerCase;
  go: Result;
  ts: Result;
  difference: Difference;
}

function firstDifference(go: unknown, ts: unknown, path: Path = []): Difference | undefined {
  if (isDeepStrictEqual(go, ts)) return;
  if (Array.isArray(go) && Array.isArray(ts)) {
    if (go.length !== ts.length) return { path: [...path, "length"], go: go.length, ts: ts.length };
    for (let i = 0; i < go.length; i++) {
      const difference = firstDifference(go[i], ts[i], [...path, i]);
      if (difference) return difference;
    }
  } else if (isObject(go) && isObject(ts)) {
    for (const key of [...new Set([...Object.keys(go), ...Object.keys(ts)])].sort()) {
      const difference = firstDifference(go[key], ts[key], [...path, key]);
      if (difference) return difference;
    }
  }
  return { path, go, ts };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function findMismatch(input: LedgerCase, go: Result): Mismatch | undefined {
  const ts = calculate(input);
  const difference = firstDifference(go, ts);
  return difference && { input, go, ts, difference };
}

export function caseSize({ records, changes, amounts }: LedgerCase): number {
  return Object.values(records).reduce((size, rows) => size + rows.length, changes.length + amounts.length);
}

function removals<T>(rows: T[]): T[][] {
  return rows.length > 1
    ? [[], ...rows.map((_, i) => rows.filter((_, index) => index !== i))]
    : rows.length === 1 ? [[]] : [];
}

function smallerCases(input: LedgerCase): LedgerCase[] {
  const candidates = [
    ...removals(input.changes).map(changes => ({ ...input, changes })),
    ...removals(input.amounts).map(amounts => ({ ...input, amounts })),
  ];
  for (const key of Object.keys(input.records) as (keyof LedgerCase["records"])[]) {
    for (const rows of removals([...input.records[key]])) {
      candidates.push({ ...input, records: { ...input.records, [key]: rows } });
    }
  }
  return candidates.sort((a, b) => caseSize(a) - caseSize(b));
}

function sameDifference(original: Mismatch, candidate: Mismatch): boolean {
  const before = original.difference;
  const after = candidate.difference;
  let path = before.path;
  const [field, index] = path;
  if ((field === "amounts" || field === "changes") && typeof index === "number") {
    const input = original.input[field][index];
    const candidateIndex = candidate.input[field].findIndex(value => value === input);
    path = [field, candidateIndex, ...path.slice(2)];
  }
  return isDeepStrictEqual(path, after.path)
    && isDeepStrictEqual(before.go, after.go)
    && isDeepStrictEqual(before.ts, after.ts)
    && (field === "amounts" || field === "changes"
      || (original.go.valid === candidate.go.valid && original.ts.valid === candidate.ts.valid));
}

export function minimizeMismatch(mismatch: Mismatch, runGo: (cases: LedgerCase[]) => Result[]): Mismatch {
  while (true) {
    const candidates = smallerCases(mismatch.input);
    if (candidates.length === 0) return mismatch;
    const outputs = runGo(candidates);
    let smaller: Mismatch | undefined;
    for (const [i, input] of candidates.entries()) {
      const candidate = findMismatch(input, outputs[i]);
      if (candidate && sameDifference(mismatch, candidate)) {
        smaller = candidate;
        break;
      }
    }
    if (!smaller) return mismatch;
    mismatch = smaller;
  }
}

function describe({ input, difference }: Mismatch): string {
  const [field, index] = difference.path;
  const values = `Go = ${JSON.stringify(difference.go)}, TypeScript = ${JSON.stringify(difference.ts)}`;
  const location = difference.path.join(".") || "result";
  if (field === "amounts" && typeof index === "number") {
    return `${location} for ${JSON.stringify(input.amounts[index])}. ${values}.`;
  }
  if (field === "changes" && typeof index === "number") {
    return `${location} for ${JSON.stringify(input.changes[index].op)}. ${values}.`;
  }
  return `${location} differs. ${values}.`;
}

export function fixture(name: string, mismatch: Mismatch) {
  const { input, go, ts } = mismatch;
  const expect: {
    valid?: true | { code: NonNullable<Result["valid"]> };
    schedules: Record<string, NonNullable<Result["schedules"][string]["adjusted"]>>;
    people: Record<string, Partial<PersonBalance>>;
    home?: Partial<HomeTotals>;
    purchases?: Record<string, Partial<PurchaseView>>;
    comingUp?: ComingUpEntry[];
    chips?: Record<string, StatusChip>;
    paymentChips?: Record<string, PaymentChip[]>;
  } = { schedules: {}, people: {} };

  if (go.valid === ts.valid) expect.valid = go.valid === null ? true : { code: go.valid };
  const personIds = new Set(input.records.people.map(person => person.id));
  for (const purchase of input.records.purchases) {
    const { id, personId } = purchase;
    const schedule = go.schedules[id];
    // The Go fixture runner also checks the base inferred from adjusted.
    // The TypeScript fixture runner only builds schedules for existing people.
    if (personIds.has(personId) && schedule?.adjusted && isDeepStrictEqual(schedule, ts.schedules[id])) {
      expect.schedules[id] = schedule.adjusted;
    }
  }
  for (const [id, balance] of Object.entries(go.people)) {
    const tsBalance = ts.people[id];
    if (!tsBalance) continue;
    const fields = Object.keys(balance) as (keyof typeof balance)[];
    const agreed = fields.filter(key => key !== "personId" && balance[key] === tsBalance[key]);
    if (agreed.length) expect.people[id] = Object.fromEntries(agreed.map(key => [key, balance[key]]));
  }

  const agreeingFields = <T extends object>(goValue: T, tsValue: T | undefined, skip: string[] = []) => {
    const fields = (Object.keys(goValue) as (keyof T & string)[])
      .filter(key => !skip.includes(key) && isDeepStrictEqual(goValue[key], tsValue?.[key]));
    return Object.fromEntries(fields.map(key => [key, goValue[key]])) as Partial<T>;
  };
  for (const [id, balance] of Object.entries(go.view.balances)) {
    const agreed = agreeingFields(balance, ts.view.balances[id], ["personId"]);
    if (Object.keys(agreed).length) expect.people[id] = { ...expect.people[id], ...agreed };
  }
  const home = agreeingFields(go.view.home, ts.view.home);
  if (Object.keys(home).length) expect.home = home;
  for (const [id, purchase] of Object.entries(go.view.purchases)) {
    const agreed = agreeingFields(purchase, ts.view.purchases[id], ["purchaseId"]);
    if (Object.keys(agreed).length) (expect.purchases ??= {})[id] = agreed;
  }
  if (isDeepStrictEqual(go.view.comingUp, ts.view.comingUp)) expect.comingUp = go.view.comingUp;
  for (const [id, chip] of Object.entries(go.view.chips)) {
    if (isDeepStrictEqual(chip, ts.view.chips[id])) (expect.chips ??= {})[id] = chip;
  }
  for (const [id, chips] of Object.entries(go.paymentChips)) {
    if (isDeepStrictEqual(chips, ts.paymentChips[id])) (expect.paymentChips ??= {})[id] = chips;
  }

  return { name, description: describe(mismatch), timeZone: input.timeZone, today: input.today, records: input.records, expect };
}
