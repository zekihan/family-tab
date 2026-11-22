import type { Purchase, Refund, ScheduledAmount } from "../types.ts";
import { addDays, addMonths, clampedDate, isValidDate, lastDayOfMonth } from "./dates.ts";
import { isValidAmount } from "./limits.ts";

export function buildSchedule(p: Purchase): ScheduledAmount[] {
  if (p.plan === "once") {
    return [{
      purchaseId: p.id, sequence: 1, baseMinor: p.totalMinor, adjustedMinor: p.totalMinor, dueOn: p.dueDate,
    }];
  }

  const count = p.count!;
  const base = Math.floor(p.totalMinor / count);
  const remainder = p.totalMinor % count;
  return Array.from({ length: count }, (_, index) => {
    const amount = base + (index < remainder ? 1 : 0);
    return {
      purchaseId: p.id,
      sequence: index + 1,
      baseMinor: amount,
      adjustedMinor: amount,
      dueOn: addMonths(p.firstDue!, index, p.dueDay!),
    };
  });
}

export function adjustedSchedule(p: Purchase, refunds: Refund[]): ScheduledAmount[] {
  const schedule = buildSchedule(p);
  let remaining = refunds.reduce((sum, refund) => sum + (refund.purchaseId === p.id ? refund.amountMinor : 0), 0);
  for (let index = schedule.length - 1; index >= 0 && remaining > 0; index--) {
    const entry = schedule[index];
    const reduction = Math.min(remaining, entry.adjustedMinor);
    entry.adjustedMinor -= reduction;
    remaining -= reduction;
  }
  return schedule;
}

export function firstPaydayOnOrAfter(today: string, payday: number): string {
  const thisMonth = addMonths(today, 0, payday);
  return thisMonth >= today ? thisMonth : addMonths(today, 1, payday);
}

export interface DueShortcuts {
  payday: string | null;
  endOfMonth: string;
  inTwoWeeks: string;
}

export function dueShortcuts(today: string, payday: number | null): DueShortcuts {
  return {
    payday: payday === null ? null : firstPaydayOnOrAfter(today, payday),
    endOfMonth: lastDayOfMonth(today),
    inTwoWeeks: addDays(today, 14),
  };
}

export function defaultInstallmentStart(today: string, payday: number | null): { firstDue: string; dueDay: number } {
  return {
    firstDue: payday === null ? addMonths(today, 1) : firstPaydayOnOrAfter(today, payday),
    dueDay: payday ?? Number(today.slice(8)),
  };
}

export interface InstallmentPreview {
  count: number;
  first: string;
  last: string;
  minAmount: number;
  maxAmount: number;
}

export function installmentPreview(
  totalMinor: number, count: number, firstDue: string, dueDay: number,
): InstallmentPreview | null {
  if (!isValidAmount(totalMinor) || !Number.isInteger(count) || count < 2 || count > 120 || totalMinor < count) {
    return null;
  }
  if (!isValidDate(firstDue) || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;

  const [year, month] = firstDue.split("-").map(Number);
  if (clampedDate(year, month, dueDay) !== firstDue) return null;
  const last = addMonths(firstDue, count - 1, dueDay);
  if (!isValidDate(last)) return null;
  return {
    count,
    first: firstDue,
    last,
    minAmount: Math.floor(totalMinor / count),
    maxAmount: Math.ceil(totalMinor / count),
  };
}
