import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

function fixture(t: TestContext, script: string) {
  const root = mkdtempSync(join(tmpdir(), "family-tab-install-scripts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = ".github/scripts";
  mkdirSync(join(root, scripts), { recursive: true });
  const path = join(scripts, script);
  copyFileSync(new URL(`../../${path}`, import.meta.url), join(root, path));
  return { root, path };
}

test("the build installer passes --ignore-scripts to npm ci", t => {
  const { root, path } = fixture(t, "install_build_deps.sh");
  writeFileSync(join(root, "npm"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  const args = execFileSync("sh", [path], {
    cwd: root,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(args, "ci\n--prefix\nweb\n--ignore-scripts\n");
});

test("the lockfile checker requires exact approvals for Linux dependencies", t => {
  const { root, path } = fixture(t, "check_web_install_scripts.mjs");
  const web = join(root, "web");
  mkdirSync(web);
  const allowScripts = { "approved@1.2.3": true, "@scope/native@2.0.0": true };
  writeFileSync(join(web, "package.json"), JSON.stringify({ allowScripts }));
  const script = { hasInstallScript: true, version: "1.2.3" };
  const packages = {
    "node_modules/approved": script,
    "node_modules/parent/node_modules/@scope/native": { ...script, version: "2.0.0" },
    "node_modules/native-alias": { ...script, name: "@scope/native", version: "2.0.0" },
    "node_modules/macos": { ...script, optional: true, os: ["darwin"] },
    "node_modules/non-linux": { ...script, optional: true, os: ["!linux"] },
  };
  function check(entries: Record<string, object>) {
    writeFileSync(join(web, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: entries }));
    return spawnSync(process.execPath, [path], { cwd: root, encoding: "utf8" });
  }

  const approved = check(packages);
  assert.equal(approved.status, 0, approved.stderr);

  const unapproved = check({
    ...packages,
    "node_modules/approved": { ...script, version: "1.2.4" },
    "node_modules/native": { ...script, optional: true, os: ["!darwin"] },
    "node_modules/portable": { ...script, optional: true, os: ["any"] },
    "node_modules/required": { ...script, os: ["darwin"] },
  });
  assert.equal(unapproved.status, 1, unapproved.stderr);
  assert.match(unapproved.stderr, /Unapproved install script: approved@1\.2\.4/);
  assert.match(unapproved.stderr, /Unapproved install script: native@1\.2\.3/);
  assert.match(unapproved.stderr, /Unapproved install script: portable@1\.2\.3/);
  assert.match(unapproved.stderr, /Unapproved install script: required@1\.2\.3/);
});
