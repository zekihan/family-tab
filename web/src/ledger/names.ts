// Person name comparison. Mirrors internal/ledger/normalize.go.

const NAME_SPACE = /[\p{White_Space}\uFEFF]+/u;
const FOLDS: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };
const COMBINING_DOT_ABOVE = "\u0307";

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
