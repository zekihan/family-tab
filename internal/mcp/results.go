package mcp

import (
	"cmp"
	"slices"

	"github.com/zekihan/family-tab/internal/ledger"
)

// Result types. Every amount appears twice: as integer kuruş in a field ending
// in Minor and as formatted lira text in the field of the same name without it.

type personResult struct {
	Payday   *int     `json:"payday"`
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Aliases  []string `json:"aliases"`
	Archived bool     `json:"archived"`
}

func newPersonResult(person *ledger.Person) personResult {
	aliases := person.Aliases
	if aliases == nil {
		aliases = []string{}
	}

	return personResult{
		Payday: person.Payday, ID: person.ID, Name: person.Name,
		Aliases: aliases, Archived: person.Archived,
	}
}

func newPersonResults(people []ledger.Person) []personResult {
	results := make([]personResult, 0, len(people))
	for index := range people {
		results = append(results, newPersonResult(&people[index]))
	}

	return results
}

type statusResult struct {
	Kind        string `json:"kind"`
	Date        string `json:"date,omitempty"`
	Amount      string `json:"amount,omitempty"`
	AmountMinor int64  `json:"amountMinor"`
	BehindPlan  bool   `json:"behindPlan"`
}

type balanceResult struct {
	EarliestUnpaidFuture  *string      `json:"earliestUnpaidFuture"`
	LeftToPay             string       `json:"leftToPay"`
	DueByToday            string       `json:"dueByToday"`
	DueNextMonth          string       `json:"dueNextMonth"`
	PaymentsReceived      string       `json:"paymentsReceived"`
	CashReturned          string       `json:"cashReturned"`
	NetReceipts           string       `json:"netReceipts"`
	Credit                string       `json:"credit"`
	CashShortfall         string       `json:"cashShortfall"`
	Status                statusResult `json:"status"`
	LeftToPayMinor        int64        `json:"leftToPayMinor"`
	DueByTodayMinor       int64        `json:"dueByTodayMinor"`
	DueNextMonthMinor     int64        `json:"dueNextMonthMinor"`
	PaymentsReceivedMinor int64        `json:"paymentsReceivedMinor"`
	CashReturnedMinor     int64        `json:"cashReturnedMinor"`
	NetReceiptsMinor      int64        `json:"netReceiptsMinor"`
	CreditMinor           int64        `json:"creditMinor"`
	CashShortfallMinor    int64        `json:"cashShortfallMinor"`
	BehindPlan            bool         `json:"behindPlan"`
}

func newBalanceResult(view *ledger.LedgerView, personID string) balanceResult {
	balance := view.Balances[personID]
	chip := view.Chips[personID]

	status := statusResult{
		Kind:        chip.Kind,
		Date:        chip.Date,
		Amount:      "",
		AmountMinor: chip.AmountMinor,
		BehindPlan:  chip.BehindPlan,
	}
	if chip.AmountMinor > 0 {
		status.Amount = formatTRY(chip.AmountMinor)
	}

	return balanceResult{
		EarliestUnpaidFuture:  balance.EarliestUnpaidFuture,
		LeftToPay:             formatTRY(balance.LeftToPay),
		DueByToday:            formatTRY(balance.DueByToday),
		DueNextMonth:          formatTRY(balance.DueNextMonth),
		PaymentsReceived:      formatTRY(balance.PaymentsReceived),
		CashReturned:          formatTRY(balance.CashReturned),
		NetReceipts:           formatTRY(balance.NetReceipts),
		Credit:                formatTRY(balance.Credit),
		CashShortfall:         formatTRY(balance.CashShortfall),
		Status:                status,
		LeftToPayMinor:        balance.LeftToPay,
		DueByTodayMinor:       balance.DueByToday,
		DueNextMonthMinor:     balance.DueNextMonth,
		PaymentsReceivedMinor: balance.PaymentsReceived,
		CashReturnedMinor:     balance.CashReturned,
		NetReceiptsMinor:      balance.NetReceipts,
		CreditMinor:           balance.Credit,
		CashShortfallMinor:    balance.CashShortfall,
		BehindPlan:            balance.BehindPlan,
	}
}

type paymentChipResult struct {
	Kind           string `json:"kind"`
	Amount         string `json:"amount"`
	Shortfall      string `json:"shortfall"`
	AmountMinor    int64  `json:"amountMinor"`
	ShortfallMinor int64  `json:"shortfallMinor"`
}

func newPaymentChipResults(
	view *ledger.LedgerView, records *ledger.Records, personID string,
) []paymentChipResult {
	chips := ledger.PaymentChips(view, records, personID)
	results := make([]paymentChipResult, 0, len(chips))

	for _, chip := range chips {
		results = append(results, paymentChipResult{
			Kind: chip.Kind, Amount: formatTRY(chip.AmountMinor),
			Shortfall:   formatTRY(chip.ShortfallMinor),
			AmountMinor: chip.AmountMinor, ShortfallMinor: chip.ShortfallMinor,
		})
	}

	return results
}

type installmentResult struct {
	DueOn          *string `json:"dueOn"`
	Adjusted       string  `json:"adjusted"`
	Paid           string  `json:"paid"`
	Remaining      string  `json:"remaining"`
	Sequence       int     `json:"sequence"`
	AdjustedMinor  int64   `json:"adjustedMinor"`
	PaidMinor      int64   `json:"paidMinor"`
	RemainingMinor int64   `json:"remainingMinor"`
	Overdue        bool    `json:"overdue"`
}

type purchaseResult struct {
	DueDate         *string             `json:"dueDate"`
	Count           *int                `json:"count"`
	FirstDue        *string             `json:"firstDue"`
	DueDay          *int                `json:"dueDay"`
	Note            *string             `json:"note"`
	ID              string              `json:"id"`
	PersonID        string              `json:"personId"`
	PersonName      string              `json:"personName"`
	Item            string              `json:"item"`
	BoughtOn        string              `json:"boughtOn"`
	Plan            string              `json:"plan"`
	Source          string              `json:"source"`
	Total           string              `json:"total"`
	Refunded        string              `json:"refunded"`
	Refundable      string              `json:"refundable"`
	Left            string              `json:"left"`
	Installments    []installmentResult `json:"installments,omitempty"`
	TotalMinor      int64               `json:"totalMinor"`
	RefundedMinor   int64               `json:"refundedMinor"`
	RefundableMinor int64               `json:"refundableMinor"`
	LeftMinor       int64               `json:"leftMinor"`
}

// newPurchaseResult describes a purchase. Schedule is "none" (no
// installments), "unpaid" (only installments with something left) or "all".
func (st *state) newPurchaseResult(purchase *ledger.Purchase, schedule string) purchaseResult {
	var refunded, left int64

	view := st.view.Purchases[purchase.ID]
	if view != nil {
		refunded, left = view.RefundedMinor, view.LeftMinor
	}

	result := purchaseResult{
		DueDate: purchase.DueDate, Count: purchase.Count, FirstDue: purchase.FirstDue,
		DueDay: purchase.DueDay, Note: purchase.Note, ID: purchase.ID,
		PersonID: purchase.PersonID, PersonName: st.personName(purchase.PersonID),
		Item: purchase.Item, BoughtOn: purchase.BoughtOn, Plan: purchase.Plan,
		Source: purchase.Source, Total: formatTRY(purchase.TotalMinor),
		Refunded: formatTRY(refunded), Refundable: formatTRY(purchase.TotalMinor - refunded),
		Left: formatTRY(left), Installments: nil, TotalMinor: purchase.TotalMinor,
		RefundedMinor: refunded, RefundableMinor: purchase.TotalMinor - refunded, LeftMinor: left,
	}

	if schedule != scheduleNone && view != nil {
		result.Installments = st.installments(view, schedule == scheduleAll)
	}

	return result
}

const (
	scheduleNone   = "none"
	scheduleUnpaid = "unpaid"
	scheduleAll    = "all"
)

func (st *state) installments(view *ledger.PurchaseView, includePaid bool) []installmentResult {
	results := make([]installmentResult, 0, len(view.Adjusted))

	for index, amount := range view.Adjusted {
		paid := view.Paid[index]

		remaining := amount.AdjustedMinor - paid
		if remaining <= 0 && !includePaid {
			continue
		}

		overdue := amount.DueOn != nil && *amount.DueOn < st.today && remaining > 0

		results = append(results, installmentResult{
			DueOn: amount.DueOn, Adjusted: formatTRY(amount.AdjustedMinor),
			Paid: formatTRY(paid), Remaining: formatTRY(remaining), Sequence: amount.Sequence,
			AdjustedMinor: amount.AdjustedMinor, PaidMinor: paid, RemainingMinor: remaining,
			Overdue: overdue,
		})
	}

	return results
}

// purchasesOf returns the person's purchases, oldest first.
func (st *state) purchasesOf(personID string) []*ledger.Purchase {
	var purchases []*ledger.Purchase

	for index := range st.snapshot.Purchases {
		purchase := &st.snapshot.Purchases[index]
		if purchase.PersonID == personID {
			purchases = append(purchases, purchase)
		}
	}

	slices.SortFunc(purchases, func(left, right *ledger.Purchase) int {
		return cmp.Or(cmp.Compare(left.BoughtOn, right.BoughtOn), cmp.Compare(left.ID, right.ID))
	})

	return purchases
}

type paymentResult struct {
	Note        *string `json:"note"`
	ID          string  `json:"id"`
	PersonID    string  `json:"personId"`
	PersonName  string  `json:"personName"`
	Amount      string  `json:"amount"`
	PaidOn      string  `json:"paidOn"`
	Source      string  `json:"source"`
	AmountMinor int64   `json:"amountMinor"`
}

type refundResult struct {
	Note        *string `json:"note"`
	ID          string  `json:"id"`
	PurchaseID  string  `json:"purchaseId"`
	Item        string  `json:"item"`
	Amount      string  `json:"amount"`
	RefundedOn  string  `json:"refundedOn"`
	Source      string  `json:"source"`
	AmountMinor int64   `json:"amountMinor"`
}
