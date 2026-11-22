import type {
  ComingUpEntry, HomeTotals, PaymentChip, PersonBalance, Records, ScheduledAmount, StatusChip,
} from "../types.ts";
import type { LedgerView, PurchaseView } from "./index.ts";
import { addMonths, compareDates, isValidDate } from "./dates.ts";
import { adjustedSchedule, buildSchedule } from "./schedule.ts";

interface ScheduleEntry {
  amount: ScheduledAmount;
  boughtOn: string;
  purchase: PurchaseView;
}

function compareEntries(a: ScheduleEntry, b: ScheduleEntry): number {
  const first = a.amount;
  const second = b.amount;
  return Number(first.dueOn === null) - Number(second.dueOn === null)
    || compareDates(first.dueOn ?? "", second.dueOn ?? "")
    || compareDates(a.boughtOn, b.boughtOn)
    || compareDates(first.purchaseId, second.purchaseId)
    || first.sequence - second.sequence;
}

function groupBy<T>(records: T[], keyOf: (record: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

function statusChip(balance: PersonBalance): StatusChip {
  const { credit, leftToPay, dueByToday, earliestUnpaidFuture, behindPlan } = balance;
  if (credit > 0) return { kind: "credit", amountMinor: credit, behindPlan: false };
  if (leftToPay === 0) return { kind: "allPaid", behindPlan: false };
  if (dueByToday > 0) return { kind: "dueByToday", amountMinor: dueByToday, behindPlan };
  if (earliestUnpaidFuture !== null) return { kind: "nextDate", date: earliestUnpaidFuture, behindPlan };
  return { kind: "whenTheyCan", behindPlan };
}

export function computeLedger(records: Records, today: string): LedgerView {
  const purchases = new Map<string, PurchaseView>();
  const balances = new Map<string, PersonBalance>();
  const chips = new Map<string, StatusChip>();
  const upcoming: { entry: ScheduleEntry; row: ComingUpEntry }[] = [];
  const home: HomeTotals = { leftToPay: 0, dueByToday: 0, dueNextMonth: 0, credit: 0, archivedLeftToPay: 0 };
  const nextMonth = addMonths(today, 1);
  const windowEnd = isValidDate(nextMonth) ? nextMonth : "9999-12-31";

  const purchasesByPerson = groupBy(records.purchases, purchase => purchase.personId);
  const refundsByPurchase = groupBy(records.refunds, refund => refund.purchaseId);
  const paymentsByPerson = groupBy(records.payments, payment => payment.personId);
  const payoutsByPerson = groupBy(records.payouts, payout => payout.personId);

  for (const person of records.people) {
    const entries: ScheduleEntry[] = [];
    for (const purchase of purchasesByPerson.get(person.id) ?? []) {
      const refunds = refundsByPurchase.get(purchase.id) ?? [];
      const adjusted = adjustedSchedule(purchase, refunds);
      const view: PurchaseView = {
        purchaseId: purchase.id,
        base: buildSchedule(purchase),
        adjusted,
        paid: adjusted.map(() => 0),
        refundedMinor: refunds.reduce((sum, refund) => sum + refund.amountMinor, 0),
        leftMinor: 0,
        earliestUnpaidDue: null,
        paidCount: 0,
        payableCount: adjusted.filter(amount => amount.adjustedMinor > 0).length,
      };
      purchases.set(purchase.id, view);
      for (const amount of adjusted) {
        if (amount.adjustedMinor > 0) entries.push({ amount, boughtOn: purchase.boughtOn, purchase: view });
      }
    }
    entries.sort(compareEntries);

    const paymentsReceived = (paymentsByPerson.get(person.id) ?? []).reduce((sum, entry) => sum + entry.amountMinor, 0);
    const cashReturned = (payoutsByPerson.get(person.id) ?? []).reduce((sum, entry) => sum + entry.amountMinor, 0);
    const netReceipts = paymentsReceived - cashReturned;
    const cashShortfall = Math.max(0, -netReceipts);
    const balance: PersonBalance = {
      personId: person.id,
      leftToPay: cashShortfall,
      dueByToday: 0,
      dueNextMonth: 0,
      behindPlan: false,
      paymentsReceived,
      cashReturned,
      netReceipts,
      credit: Math.max(0, netReceipts),
      cashShortfall,
      earliestUnpaidFuture: null,
    };

    for (const entry of entries) {
      const { amount, purchase } = entry;
      const { dueOn, sequence, adjustedMinor } = amount;
      const paid = Math.min(balance.credit, adjustedMinor);
      balance.credit -= paid;
      purchase.paid[sequence - 1] = paid;
      const remainingMinor = adjustedMinor - paid;
      if (remainingMinor === 0) {
        purchase.paidCount++;
        continue;
      }

      purchase.leftMinor += remainingMinor;
      balance.leftToPay += remainingMinor;
      if (dueOn === null) continue;

      purchase.earliestUnpaidDue ??= dueOn;
      if (dueOn <= today) {
        balance.dueByToday += remainingMinor;
        if (dueOn < today) balance.behindPlan = true;
      } else {
        balance.earliestUnpaidFuture ??= dueOn;
        if (dueOn <= windowEnd) {
          balance.dueNextMonth += remainingMinor;
          upcoming.push({
            entry,
            row: {
              personId: person.id, purchaseId: purchase.purchaseId, sequence, dueOn,
              remainingMinor, archived: person.archived,
            },
          });
        }
      }
    }

    balances.set(person.id, balance);
    chips.set(person.id, statusChip(balance));
    home.leftToPay += balance.leftToPay;
    home.dueByToday += balance.dueByToday;
    home.dueNextMonth += balance.dueNextMonth;
    home.credit += balance.credit;
    if (person.archived) home.archivedLeftToPay += balance.leftToPay;
  }

  const homeOrder = records.people.filter(person => !person.archived).sort((a, b) => {
    const first = balances.get(a.id)!;
    const second = balances.get(b.id)!;
    return second.dueByToday - first.dueByToday
      || second.leftToPay - first.leftToPay
      || a.name.localeCompare(b.name, "tr")
      || compareDates(a.id, b.id);
  }).map(person => person.id);
  upcoming.sort((a, b) => compareEntries(a.entry, b.entry));
  return {
    today,
    balances: Object.fromEntries(balances),
    chips: Object.fromEntries(chips),
    purchases: Object.fromEntries(purchases),
    home,
    comingUp: upcoming.slice(0, 8).map(({ row }) => row),
    homeOrder,
  };
}

export function paymentChips(view: LedgerView, records: Records, personId: string): PaymentChip[] {
  if (!Object.hasOwn(view.balances, personId)) return [];

  const { dueByToday, leftToPay, cashShortfall, earliestUnpaidFuture } = view.balances[personId];
  const chips: PaymentChip[] = [];
  const add = (kind: PaymentChip["kind"], amountMinor: number) => {
    if (amountMinor > 0) chips.push({ kind, amountMinor, shortfallMinor: cashShortfall });
  };

  const dueWithShortfall = dueByToday + cashShortfall;
  add("dueByToday", dueWithShortfall);
  if (earliestUnpaidFuture !== null) {
    let throughNextDue = dueWithShortfall;
    for (const purchase of records.purchases) {
      if (purchase.personId !== personId) continue;
      const { adjusted, paid } = view.purchases[purchase.id];
      adjusted.forEach((amount, index) => {
        if (amount.dueOn === earliestUnpaidFuture) throughNextDue += amount.adjustedMinor - paid[index];
      });
    }
    add("throughNextDue", throughNextDue);
  }
  add("everything", leftToPay);
  return chips;
}
