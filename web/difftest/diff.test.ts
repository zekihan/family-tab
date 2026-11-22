import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Result } from "./calculate.ts";
import { generateCases } from "./generate.ts";
import type { LedgerCase } from "./generate.ts";
import { caseSize, findMismatch, fixture, minimizeMismatch } from "./mismatch.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixedSeeds = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  101, 202, 303, 404, 505, 606, 707, 808, 909, 1010,
];
const casesPerSeed = 50;

function selectedSeeds(): number[] {
  const setting = process.env.DIFF_SEED;
  if (setting === undefined) return fixedSeeds;
  if (setting === "random") return [randomInt(0, 2 ** 32)];
  const seed = Number(setting);
  assert.ok(/^[+-]?\d+$/.test(setting) && Number.isSafeInteger(seed), "DIFF_SEED must be an integer or random");
  return [seed];
}

test("Go and TypeScript ledger rules agree", async t => {
  const seeds = selectedSeeds();
  const temporary = mkdtempSync(join(tmpdir(), "family-tab-diff-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const binary = join(temporary, process.platform === "win32" ? "ledgercalc.exe" : "ledgercalc");
  execFileSync("go", ["build", "-o", binary, "./cmd/ledgercalc"], { cwd: root, stdio: "inherit" });

  const runGo = (cases: LedgerCase[]): Result[] => {
    const json = execFileSync(binary, [], {
      input: JSON.stringify({ cases }),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const outputs = JSON.parse(json) as Result[];
    assert.equal(outputs.length, cases.length, "Go must return one result per case");
    return outputs;
  };

  for (const seed of seeds) {
    await t.test(`seed ${seed} (${casesPerSeed} ledgers)`, () => {
      const cases = generateCases(seed, casesPerSeed);
      const outputs = runGo(cases);
      const failures = cases.flatMap((input, index) => {
        const mismatch = findMismatch(input, outputs[index]);
        return mismatch ? [{ index, mismatch }] : [];
      });
      if (failures.length === 0) return;

      const { index, mismatch } = failures.reduce((smallest, next) =>
        caseSize(next.mismatch.input) < caseSize(smallest.mismatch.input) ? next : smallest);
      const minimized = minimizeMismatch(mismatch, runGo);
      const name = `diff-${seed}-${index}`;
      const saved = fixture(name, minimized);
      const path = join(root, "testdata", "ledger", `${name}.json`);
      writeFileSync(path, JSON.stringify(saved, null, 2) + "\n");
      assert.fail(`DIFF_SEED=${seed}, case ${index}. ${saved.description}\nSaved ${path}`);
    });
  }
});
