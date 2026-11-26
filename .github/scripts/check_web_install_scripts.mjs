import { readFileSync } from "node:fs";

const web = new URL("../../web/", import.meta.url);
const { allowScripts = {} } = JSON.parse(readFileSync(new URL("package.json", web), "utf8"));
const { packages } = JSON.parse(readFileSync(new URL("package-lock.json", web), "utf8"));

function excludesLinux(os = []) {
  const platforms = typeof os === "string" ? [os] : os;
  if (platforms.length === 1 && platforms[0] === "any") return false;
  return platforms.includes("!linux") ||
    (!platforms.includes("linux") && platforms.some(platform => !platform.startsWith("!")));
}

for (const [location, pkg] of Object.entries(packages)) {
  if (!location || pkg.hasInstallScript !== true) continue;
  if (pkg.optional === true && excludesLinux(pkg.os)) continue;

  const name = pkg.name ?? location.split(/(?:^|\/)node_modules\//).at(-1);
  const approval = `${name}@${pkg.version}`;
  if (Object.hasOwn(allowScripts, approval) && allowScripts[approval] === true) continue;

  console.error(`Unapproved install script: ${approval} (${location}). Review web/package.json allowScripts.`);
  process.exitCode = 1;
}
