import type { DateString } from "../types.ts";

export function daysInMonth(y: number, m: number): number {
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
}

export function isValidDate(v: string): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [year, month, day] = v.split("-").map(Number);
  return year >= 1 && day >= 1 && day <= daysInMonth(year, month);
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function clampedDate(y: number, m: number, d: number): string {
  const day = Math.min(d, daysInMonth(y, m));
  return [String(y).padStart(4, "0"), String(m).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

export function addMonths(date: string, months: number, day?: number): string {
  const [year, month, originalDay] = date.split("-").map(Number);
  const offset = year * 12 + month - 1 + months;
  const targetYear = Math.floor(offset / 12);
  const targetMonth = offset - targetYear * 12 + 1;
  return clampedDate(targetYear, targetMonth, day ?? originalDay);
}

export function addDays(date: string, days: number): string {
  let [year, month, day] = date.split("-").map(Number);
  day += days;
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    month++;
    if (month === 13) {
      month = 1;
      year++;
    }
  }
  while (day < 1) {
    month--;
    if (month === 0) {
      month = 12;
      year--;
    }
    day += daysInMonth(year, month);
  }
  return clampedDate(year, month, day);
}

export function lastDayOfMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return clampedDate(year, month, 31);
}

export function todayIn(timeZone: string, nowMs = Date.now()): DateString {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowMs);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || !timeZone || timeZone === "Local" || /^[+-]/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
