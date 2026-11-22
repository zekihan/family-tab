package ledger

import (
	"cmp"
	"errors"
	"slices"
)

var (
	errScheduleAmount = errors.New("invalid purchase amount")
	errSchedulePlan   = errors.New("invalid purchase plan or installment fields")
	errScheduleDate   = errors.New("invalid due date")
	errScheduleRange  = errors.New("installment dates exceed the calendar range")
	errRefundAmount   = errors.New("invalid refund amount")
	errRefundTotal    = errors.New("refunds exceed the purchase total")
)

func scheduleStart(purchase *Purchase) (civilDate, error) {
	if purchase == nil || !validAmount(purchase.TotalMinor) {
		return civilDate{}, errScheduleAmount
	}

	switch purchase.Plan {
	case PlanOnce:
		return civilDate{}, validateOnce(purchase)
	case PlanInstallments:
		return installmentStart(purchase)
	default:
		return civilDate{}, errSchedulePlan
	}
}

func validateOnce(purchase *Purchase) error {
	if purchase.Count != nil || purchase.FirstDue != nil || purchase.DueDay != nil {
		return errSchedulePlan
	}

	if purchase.DueDate != nil {
		if _, ok := parseDate(*purchase.DueDate); !ok {
			return errScheduleDate
		}
	}

	return nil
}

func installmentStart(purchase *Purchase) (civilDate, error) {
	if purchase.Count == nil || purchase.FirstDue == nil || purchase.DueDay == nil ||
		purchase.DueDate != nil {
		return civilDate{}, errSchedulePlan
	}

	count, dueDay := *purchase.Count, *purchase.DueDay
	if count < 2 || count > 120 || dueDay < 1 || dueDay > 31 || purchase.TotalMinor < int64(count) {
		return civilDate{}, errSchedulePlan
	}

	first, ok := parseDate(*purchase.FirstDue)
	if !ok || first.day != min(dueDay, first.daysInMonth()) {
		return civilDate{}, errScheduleDate
	}

	if first.monthOffset(count-1, dueDay).year > lastCivilYear {
		return civilDate{}, errScheduleRange
	}

	return first, nil
}

func buildSchedule(purchase *Purchase) ([]ScheduledAmount, error) {
	first, err := scheduleStart(purchase)
	if err != nil {
		return nil, err
	}

	if purchase.Plan == PlanOnce {
		var dueOn *string

		if purchase.DueDate != nil {
			date := *purchase.DueDate
			dueOn = &date
		}

		return []ScheduledAmount{scheduledAmount(purchase.ID, 1, purchase.TotalMinor, dueOn)}, nil
	}

	count := *purchase.Count
	base, remainder := purchase.TotalMinor/int64(count), purchase.TotalMinor%int64(count)

	amounts := make([]ScheduledAmount, count)
	for i := range amounts {
		amount := base
		if int64(i) < remainder {
			amount++
		}

		dueOn := first.monthOffset(i, *purchase.DueDay).String()
		amounts[i] = scheduledAmount(purchase.ID, i+1, amount, &dueOn)
	}

	return amounts, nil
}

func scheduledAmount(id string, sequence int, amount int64, dueOn *string) ScheduledAmount {
	return ScheduledAmount{
		PurchaseID: id, Sequence: sequence, BaseMinor: amount, AdjustedMinor: amount, DueOn: dueOn,
	}
}

func adjustedSchedule(purchase *Purchase, refunds []Refund) ([]ScheduledAmount, error) {
	amounts, err := buildSchedule(purchase)
	if err != nil {
		return nil, err
	}

	remaining := purchase.TotalMinor
	for _, refund := range refunds {
		if refund.PurchaseID != purchase.ID {
			continue
		}

		if !validAmount(refund.AmountMinor) {
			return nil, errRefundAmount
		}

		if refund.AmountMinor > remaining {
			return nil, errRefundTotal
		}

		remaining -= refund.AmountMinor
	}

	reduction := purchase.TotalMinor - remaining
	for i := len(amounts) - 1; i >= 0 && reduction > 0; i-- {
		applied := min(reduction, amounts[i].BaseMinor)
		amounts[i].AdjustedMinor -= applied
		reduction -= applied
	}

	return amounts, nil
}

type allocationEntry struct {
	boughtOn string
	amount   ScheduledAmount
}

func compareAllocation(left, right allocationEntry) int {
	switch {
	case left.amount.DueOn == nil && right.amount.DueOn != nil:
		return 1
	case left.amount.DueOn != nil && right.amount.DueOn == nil:
		return -1
	case left.amount.DueOn != nil && right.amount.DueOn != nil:
		if order := cmp.Compare(*left.amount.DueOn, *right.amount.DueOn); order != 0 {
			return order
		}
	}

	return cmp.Or(
		cmp.Compare(left.boughtOn, right.boughtOn),
		cmp.Compare(left.amount.PurchaseID, right.amount.PurchaseID),
		cmp.Compare(left.amount.Sequence, right.amount.Sequence),
	)
}

func allocate(entries []allocationEntry, netReceipts int64) int64 {
	slices.SortFunc(entries, compareAllocation)

	remaining := max(0, netReceipts)
	for _, entry := range entries {
		remaining -= min(remaining, entry.amount.AdjustedMinor)
		if remaining == 0 {
			break
		}
	}

	return remaining
}

func balances(records *Records) map[string]PersonBalance {
	result := make(map[string]PersonBalance)
	if records == nil {
		return result
	}

	for _, person := range records.People {
		var balance PersonBalance

		balance.PersonID = person.ID
		result[person.ID] = balance
	}

	for _, payment := range records.Payments {
		if balance, ok := result[payment.PersonID]; ok {
			balance.PaymentsReceived += payment.AmountMinor
			result[payment.PersonID] = balance
		}
	}

	for _, payout := range records.Payouts {
		if balance, ok := result[payout.PersonID]; ok {
			balance.CashReturned += payout.AmountMinor
			result[payout.PersonID] = balance
		}
	}

	entries := allocationEntries(records)

	for id, balance := range result {
		balance.NetReceipts = balance.PaymentsReceived - balance.CashReturned
		balance.CashShortfall = max(0, -balance.NetReceipts)
		balance.Credit = allocate(entries[id], balance.NetReceipts)
		result[id] = balance
	}

	return result
}

func allocationEntries(records *Records) map[string][]allocationEntry {
	refunds := refundsByPurchase(records.Refunds)
	entries := make(map[string][]allocationEntry)

	for i := range records.Purchases {
		purchase := &records.Purchases[i]

		schedule, err := adjustedSchedule(purchase, refunds[purchase.ID])
		if err != nil {
			continue
		}

		for _, amount := range schedule {
			if amount.AdjustedMinor > 0 {
				entries[purchase.PersonID] = append(
					entries[purchase.PersonID],
					allocationEntry{amount: amount, boughtOn: purchase.BoughtOn},
				)
			}
		}
	}

	return entries
}

func refundsByPurchase(refunds []Refund) map[string][]Refund {
	result := make(map[string][]Refund)
	for _, refund := range refunds {
		result[refund.PurchaseID] = append(result[refund.PurchaseID], refund)
	}

	return result
}
