import { isValidAmount } from "./limits.ts";

export type ParseAmountResult = { ok: true; minor: number } | { ok: false; error: string };

export function parseAmount(input: string): ParseAmountResult {
  const invalid = { ok: false, error: "Invalid amount" } as const;
  const text = input.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, "");
  if (!/^[0-9.,]+$/.test(text)) return invalid;

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  const lastSeparator = Math.max(lastDot, lastComma);
  let integer = text;
  let fraction = "";
  if (lastSeparator !== -1) {
    const separator = text[lastSeparator];
    const mixed = lastDot !== -1 && lastComma !== -1;
    const single = text.indexOf(separator) === lastSeparator;
    if (mixed || (single && text.length - lastSeparator - 1 <= 2)) {
      if (!single) return invalid;
      integer = text.slice(0, lastSeparator);
      fraction = text.slice(lastSeparator + 1);
      if (!/^\d{1,2}$/.test(fraction)) return invalid;
    }

    if (/[.,]/.test(integer)) {
      const [first, ...groups] = integer.split(/[.,]/);
      if (!/^[1-9]\d{0,2}$/.test(first) || groups.some(group => !/^\d{3}$/.test(group))) return invalid;
      integer = first + groups.join("");
    }
  }

  if (integer.length === 0) return invalid;
  const minor = Number(integer) * 100 + Number(fraction.padEnd(2, "0"));
  return isValidAmount(minor) ? { ok: true, minor } : invalid;
}

export function formatAmountInput(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const amount = Math.abs(minor);
  const whole = Math.floor(amount / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = amount % 100;
  return sign + whole + (fraction ? "," + String(fraction).padStart(2, "0") : "");
}

export function formatTRY(minor: number): string {
  return formatAmountInput(minor) + " TL";
}
