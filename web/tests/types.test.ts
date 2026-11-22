import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_ID } from "../src/types.ts";

test("settings id is fixed", () => {
  assert.equal(SETTINGS_ID, "ledger");
});
