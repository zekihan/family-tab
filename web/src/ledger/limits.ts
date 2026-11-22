export const MAX_AMOUNT_MINOR = 10_000_000_000; // 100,000,000 TL

export function isValidAmount(minor: number): boolean {
  return Number.isInteger(minor) && minor >= 1 && minor <= MAX_AMOUNT_MINOR;
}
