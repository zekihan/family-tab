package ledger

import "slices"

const (
	comingUpLimit = 8
	lastCivilDate = "9999-12-31"
)

// Status chip kinds.
const (
	ChipCredit     = "credit"
	ChipAllPaid    = "allPaid"
	ChipDueByToday = "dueByToday"
	ChipNextDate   = "nextDate"
	ChipWhenCan    = "whenTheyCan"
)

// Payment chip kinds.
const (
	PaymentChipDueByToday  = "dueByToday"
	PaymentChipThroughNext = "throughNextDue"
	PaymentChipEverything  = "everything"
)

// BalanceView is the full per-person balance of docs/PROTOCOL.md section 7.
type BalanceView struct {
	EarliestUnpaidFuture *string `json:"earliestUnpaidFuture"`
	PersonID             string  `json:"personId"`
	LeftToPay            int64   `json:"leftToPay"`
	DueByToday           int64   `json:"dueByToday"`
	DueNextMonth         int64   `json:"dueNextMonth"`
	PaymentsReceived     int64   `json:"paymentsReceived"`
	CashReturned         int64   `json:"cashReturned"`
	NetReceipts          int64   `json:"netReceipts"`
	Credit               int64   `json:"credit"`
	CashShortfall        int64   `json:"cashShortfall"`
	BehindPlan           bool    `json:"behindPlan"`
}

type HomeTotals struct {
	LeftToPay         int64 `json:"leftToPay"`
	DueByToday        int64 `json:"dueByToday"`
	DueNextMonth      int64 `json:"dueNextMonth"`
	Credit            int64 `json:"credit"`
	ArchivedLeftToPay int64 `json:"archivedLeftToPay"`
}

type ComingUpEntry struct {
	PersonID       string `json:"personId"`
	PurchaseID     string `json:"purchaseId"`
	DueOn          string `json:"dueOn"`
	RemainingMinor int64  `json:"remainingMinor"`
	Sequence       int    `json:"sequence"`
	Archived       bool   `json:"archived"`
}

// StatusChip is the status line of a person. AmountMinor is set on credit and
// dueByToday, Date on nextDate.
type StatusChip struct {
	Kind        string `json:"kind"`
	Date        string `json:"date,omitempty"`
	AmountMinor int64  `json:"amountMinor,omitempty"`
	BehindPlan  bool   `json:"behindPlan"`
}

type PaymentChip struct {
	Kind           string `json:"kind"`
	AmountMinor    int64  `json:"amountMinor"`
	ShortfallMinor int64  `json:"shortfallMinor"`
}

// PurchaseView is the schedule of a purchase with payments allocated to it.
type PurchaseView struct {
	EarliestUnpaidDue *string           `json:"earliestUnpaidDue"`
	PurchaseID        string            `json:"purchaseId"`
	Base              []ScheduledAmount `json:"base"`
	Adjusted          []ScheduledAmount `json:"adjusted"`
	Paid              []int64           `json:"paid"`
	RefundedMinor     int64             `json:"refundedMinor"`
	LeftMinor         int64             `json:"leftMinor"`
	PaidCount         int               `json:"paidCount"`
	PayableCount      int               `json:"payableCount"`
}

type LedgerView struct {
	Balances  map[string]BalanceView   `json:"balances"`
	Chips     map[string]StatusChip    `json:"chips"`
	Purchases map[string]*PurchaseView `json:"purchases"`
	Today     string                   `json:"today"`
	ComingUp  []ComingUpEntry          `json:"comingUp"`
	Home      HomeTotals               `json:"home"`
}

type viewEntry struct {
	purchase *PurchaseView
	entry    allocationEntry
}

type upcomingEntry struct {
	source viewEntry
	row    ComingUpEntry
}

// View computes every derived figure of the ledger for the given date,
// mirroring computeLedger in web/src/ledger/balance.ts except for the Home
// row order.
func View(records *Records, today string) *LedgerView {
	view := &LedgerView{
		Today:     today,
		Balances:  make(map[string]BalanceView),
		Chips:     make(map[string]StatusChip),
		Purchases: make(map[string]*PurchaseView),
		ComingUp:  []ComingUpEntry{},
		Home: HomeTotals{
			LeftToPay: 0, DueByToday: 0, DueNextMonth: 0, Credit: 0, ArchivedLeftToPay: 0,
		},
	}
	if records == nil {
		return view
	}

	windowEnd := dueWindowEnd(today)
	refunds := refundsByPurchase(records.Refunds)
	purchasesByPerson := make(map[string][]*Purchase)

	for i := range records.Purchases {
		purchase := &records.Purchases[i]
		purchasesByPerson[purchase.PersonID] = append(
			purchasesByPerson[purchase.PersonID],
			purchase,
		)
	}

	paymentsByPerson := make(map[string]int64)
	for _, payment := range records.Payments {
		paymentsByPerson[payment.PersonID] += payment.AmountMinor
	}

	payoutsByPerson := make(map[string]int64)
	for _, payout := range records.Payouts {
		payoutsByPerson[payout.PersonID] += payout.AmountMinor
	}

	var upcoming []upcomingEntry

	for _, person := range records.People {
		entries := personEntries(view, purchasesByPerson[person.ID], refunds)
		slices.SortStableFunc(entries, compareViewEntries)

		received, returned := paymentsByPerson[person.ID], payoutsByPerson[person.ID]
		netReceipts := received - returned
		shortfall := max(0, -netReceipts)
		balance := BalanceView{
			PersonID:             person.ID,
			LeftToPay:            shortfall,
			DueByToday:           0,
			DueNextMonth:         0,
			BehindPlan:           false,
			PaymentsReceived:     received,
			CashReturned:         returned,
			NetReceipts:          netReceipts,
			Credit:               max(0, netReceipts),
			CashShortfall:        shortfall,
			EarliestUnpaidFuture: nil,
		}

		for _, entry := range entries {
			if row := allocateEntry(&balance, entry, person, today, windowEnd); row != nil {
				upcoming = append(upcoming, upcomingEntry{source: entry, row: *row})
			}
		}

		view.Balances[person.ID] = balance
		view.Chips[person.ID] = statusChip(&balance)
		view.Home.LeftToPay += balance.LeftToPay
		view.Home.DueByToday += balance.DueByToday
		view.Home.DueNextMonth += balance.DueNextMonth
		view.Home.Credit += balance.Credit

		if person.Archived {
			view.Home.ArchivedLeftToPay += balance.LeftToPay
		}
	}

	slices.SortStableFunc(upcoming, func(left, right upcomingEntry) int {
		return compareViewEntries(left.source, right.source)
	})

	for i := range min(len(upcoming), comingUpLimit) {
		view.ComingUp = append(view.ComingUp, upcoming[i].row)
	}

	return view
}

func compareViewEntries(left, right viewEntry) int {
	return compareAllocation(left.entry, right.entry)
}

func dueWindowEnd(today string) string {
	date, ok := parseDate(today)
	if !ok {
		return lastCivilDate
	}

	end := date.monthOffset(1, date.day)
	if end.year > lastCivilYear {
		return lastCivilDate
	}

	return end.String()
}

func personEntries(
	view *LedgerView,
	purchases []*Purchase,
	refunds map[string][]Refund,
) []viewEntry {
	var entries []viewEntry

	for _, purchase := range purchases {
		adjusted, err := adjustedSchedule(purchase, refunds[purchase.ID])
		if err != nil {
			continue
		}

		base, err := buildSchedule(purchase)
		if err != nil {
			continue
		}

		purchaseView := &PurchaseView{
			PurchaseID:        purchase.ID,
			Base:              base,
			Adjusted:          adjusted,
			Paid:              make([]int64, len(adjusted)),
			RefundedMinor:     0,
			LeftMinor:         0,
			EarliestUnpaidDue: nil,
			PaidCount:         0,
			PayableCount:      0,
		}
		for _, refund := range refunds[purchase.ID] {
			purchaseView.RefundedMinor += refund.AmountMinor
		}

		view.Purchases[purchase.ID] = purchaseView

		for _, amount := range adjusted {
			if amount.AdjustedMinor > 0 {
				purchaseView.PayableCount++

				entries = append(entries, viewEntry{
					purchase: purchaseView,
					entry:    allocationEntry{boughtOn: purchase.BoughtOn, amount: amount},
				})
			}
		}
	}

	return entries
}

func allocateEntry(
	balance *BalanceView, entry viewEntry, person Person, today, windowEnd string,
) *ComingUpEntry {
	amount, purchase := entry.entry.amount, entry.purchase
	paid := min(balance.Credit, amount.AdjustedMinor)
	balance.Credit -= paid
	purchase.Paid[amount.Sequence-1] = paid

	remaining := amount.AdjustedMinor - paid
	if remaining == 0 {
		purchase.PaidCount++

		return nil
	}

	purchase.LeftMinor += remaining
	balance.LeftToPay += remaining

	if amount.DueOn == nil {
		return nil
	}

	dueOn := *amount.DueOn
	if purchase.EarliestUnpaidDue == nil {
		purchase.EarliestUnpaidDue = &dueOn
	}

	if dueOn <= today {
		balance.DueByToday += remaining
		balance.BehindPlan = balance.BehindPlan || dueOn < today

		return nil
	}

	if balance.EarliestUnpaidFuture == nil {
		balance.EarliestUnpaidFuture = &dueOn
	}

	if dueOn > windowEnd {
		return nil
	}

	balance.DueNextMonth += remaining

	return &ComingUpEntry{
		PersonID: person.ID, PurchaseID: purchase.PurchaseID, Sequence: amount.Sequence,
		DueOn: dueOn, RemainingMinor: remaining, Archived: person.Archived,
	}
}

func statusChip(balance *BalanceView) StatusChip {
	switch {
	case balance.Credit > 0:
		return StatusChip{
			Kind:        ChipCredit,
			Date:        "",
			AmountMinor: balance.Credit,
			BehindPlan:  false,
		}
	case balance.LeftToPay == 0:
		return StatusChip{Kind: ChipAllPaid, Date: "", AmountMinor: 0, BehindPlan: false}
	case balance.DueByToday > 0:
		return StatusChip{
			Kind:        ChipDueByToday,
			Date:        "",
			AmountMinor: balance.DueByToday,
			BehindPlan:  balance.BehindPlan,
		}
	case balance.EarliestUnpaidFuture != nil:
		return StatusChip{
			Kind: ChipNextDate, Date: *balance.EarliestUnpaidFuture, AmountMinor: 0,
			BehindPlan: balance.BehindPlan,
		}
	default:
		return StatusChip{
			Kind:        ChipWhenCan,
			Date:        "",
			AmountMinor: 0,
			BehindPlan:  balance.BehindPlan,
		}
	}
}

// PaymentChips returns the suggested payment amounts of a person, the default
// first, mirroring paymentChips in web/src/ledger/balance.ts.
func PaymentChips(view *LedgerView, records *Records, personID string) []PaymentChip {
	chips := []PaymentChip{}

	balance, ok := view.Balances[personID]
	if !ok {
		return chips
	}

	add := func(kind string, amountMinor int64) {
		if amountMinor > 0 {
			chips = append(chips, PaymentChip{
				Kind: kind, AmountMinor: amountMinor, ShortfallMinor: balance.CashShortfall,
			})
		}
	}

	dueWithShortfall := balance.DueByToday + balance.CashShortfall
	add(PaymentChipDueByToday, dueWithShortfall)

	if balance.EarliestUnpaidFuture != nil {
		throughNextDue := dueWithShortfall

		for i := range records.Purchases {
			purchase := &records.Purchases[i]

			purchaseView, ok := view.Purchases[purchase.ID]
			if purchase.PersonID != personID || !ok {
				continue
			}

			for index, amount := range purchaseView.Adjusted {
				if amount.DueOn != nil && *amount.DueOn == *balance.EarliestUnpaidFuture {
					throughNextDue += amount.AdjustedMinor - purchaseView.Paid[index]
				}
			}
		}

		add(PaymentChipThroughNext, throughNextDue)
	}

	add(PaymentChipEverything, balance.LeftToPay)

	return chips
}
