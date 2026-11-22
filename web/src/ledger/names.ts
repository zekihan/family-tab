// Person name and alias rules. Mirrors internal/ledger/normalize.go and
// internal/ledger/alias.go.

import type { Person } from "../types.ts";
import type { RuleError } from "./index.ts";

const NAME_SPACE = /[\p{White_Space}\uFEFF]+/u;
const FOLDS: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };
const COMBINING_DOT_ABOVE = "\u0307";

export const MAX_ALIASES = 20;
export const MAX_ALIAS_LENGTH = 40;

/** Trims White_Space and U+FEFF from both ends and collapses internal runs to one space. */
export function trimName(input: string): string {
  return input.split(NAME_SPACE).filter(part => part !== "").join(" ");
}

function lowerChar(char: string): string {
  if (char === "I") return "ı";
  if (char === "İ") return "i";
  return char.toLowerCase();
}

/** The comparison key for person names and aliases. */
export function normalizeName(input: string): string {
  return [...trimName(input.normalize("NFC"))]
    .map(char => [...lowerChar(char)].map(lower => lower === COMBINING_DOT_ABOVE ? "" : FOLDS[lower] ?? lower).join(""))
    .join("");
}

function rule(code: RuleError["code"], reason: string, blocking: string[] = []): RuleError {
  return { code, reason, blocking };
}

/** Record rules on one person's aliases. */
export function validateAliases(person: Pick<Person, "name" | "aliases">): RuleError | null {
  const { aliases } = person;
  if (!Array.isArray(aliases)) return rule("invalid", "Aliases must be a list.");
  if (aliases.length > MAX_ALIASES) return rule("invalid", `A person can have at most ${MAX_ALIASES} aliases.`);
  const seen = new Set([normalizeName(person.name)]);
  for (const alias of aliases) {
    const key = typeof alias === "string" ? normalizeName(alias) : "";
    if (key === "" || alias !== trimName(alias) || [...alias].length > MAX_ALIAS_LENGTH) {
      return rule("invalid", `Each alias must be trimmed and contain 1 to ${MAX_ALIAS_LENGTH} characters.`);
    }
    if (seen.has(key)) return rule("invalid", "Aliases must differ from each other and from the name.");
    seen.add(key);
  }
  return null;
}

/** People other than `person` whose name or aliases match its name or aliases; name-to-name is allowed. */
export function aliasConflicts(people: readonly Person[], person: Pick<Person, "id" | "name" | "aliases">): string[] {
  const name = normalizeName(person.name);
  const aliases = new Set(person.aliases.map(normalizeName));
  return people.filter(other => {
    if (other.id === person.id) return false;
    const otherAliases = other.aliases.map(normalizeName);
    return aliases.has(normalizeName(other.name)) || otherAliases.some(key => key === name || aliases.has(key));
  }).map(other => other.id).sort();
}

export function validateAliasConflicts(people: readonly Person[], person: Person): RuleError | null {
  const blocking = aliasConflicts(people, person);
  return blocking.length ? rule("alias_conflict", "A name or alias matches another person.", blocking) : null;
}
