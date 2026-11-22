package ledger

import (
	"slices"
	"strings"
	"testing"
)

const (
	testToday    = "2025-11-22"
	testEarlier  = "2025-11-20"
	testFuture   = "2025-11-23"
	testPerson   = "person-1"
	testPurchase = "purchase-1"
	testPayment  = "payment-1"
	testRefund   = "refund-1"
	testPayout   = "payout-1"
)

func baselineRecords() Records {
	var settings Settings

	settings.ID, settings.TimeZone, settings.Currency = SettingsID, "UTC", CurrencyTRY

	var person Person

	person.ID, person.Name = testPerson, "Buyer"

	var purchase Purchase

	purchase.ID, purchase.PersonID, purchase.Item = testPurchase, testPerson, "Item"
	purchase.TotalMinor, purchase.BoughtOn, purchase.Plan = 500, testEarlier, PlanOnce

	var payment Payment

	payment.ID, payment.PersonID, payment.AmountMinor = testPayment, testPerson, 1200
	payment.PaidOn = testToday

	var refund Refund

	refund.ID, refund.PurchaseID, refund.AmountMinor = testRefund, testPurchase, 100
	refund.RefundedOn = testToday

	var payout Payout

	payout.ID, payout.PersonID, payout.AmountMinor = testPayout, testPerson, 300
	payout.PaidOutOn = testToday

	return Records{
		Settings: &settings, People: []Person{person}, Purchases: []Purchase{purchase},
		Payments: []Payment{payment}, Refunds: []Refund{refund}, Payouts: []Payout{payout},
	}
}

func installmentPurchase(total int64, count, day int, due string) Purchase {
	purchase := baselineRecords().Purchases[0]
	purchase.TotalMinor, purchase.Plan = total, PlanInstallments
	purchase.Count, purchase.DueDay, purchase.FirstDue = &count, &day, &due

	return purchase
}

func changeFor(kind, recordType, recordID string) Change {
	return Change{Kind: kind, RecordType: recordType, RecordID: recordID, AlreadyReturned: false}
}

func TestRecordRules(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		edit func(*Records)
		code string
	}{
		{"baseline", func(_ *Records) {}, ""},
		{"no settings", func(r *Records) { r.Settings = nil }, CodeInvalid},
		{"wrong ID", func(r *Records) { r.Settings.ID = "other" }, CodeInvalid},
		{"wrong currency", func(r *Records) { r.Settings.Currency = "EUR" }, CodeInvalid},
		{"empty zone", func(r *Records) { r.Settings.TimeZone = "" }, CodeInvalid},
		{"local zone", func(r *Records) { r.Settings.TimeZone = "Local" }, CodeInvalid},
		{"unknown zone", func(r *Records) { r.Settings.TimeZone = "No/Such_Zone" }, CodeInvalid},
		{"IANA zone", func(r *Records) { r.Settings.TimeZone = "Europe/Istanbul" }, ""},
		{
			"long name",
			func(r *Records) { r.People[0].Name = strings.Repeat("ş", 201) },
			CodeInvalid,
		},
		{"name limit", func(r *Records) { r.People[0].Name = strings.Repeat("ş", 200) }, ""},
		{"blank name", func(r *Records) { r.People[0].Name = " \t" }, CodeInvalid},
		{"max payday", func(r *Records) { r.People[0].Payday = new(31) }, ""},
		{"blank item", func(r *Records) { r.Purchases[0].Item = " \t" }, CodeInvalid},
		{
			"long item",
			func(r *Records) { r.Purchases[0].Item = strings.Repeat("x", 201) },
			CodeInvalid,
		},
		{"note limit", func(r *Records) { r.Payouts[0].Note = new(strings.Repeat("ş", 500)) }, ""},
		{
			"long note",
			func(r *Records) { r.Refunds[0].Note = new(strings.Repeat("ş", 501)) },
			CodeInvalid,
		},
		{"zero payment", func(r *Records) { r.Payments[0].AmountMinor = 0 }, CodeInvalid},
		{"negative refund", func(r *Records) { r.Refunds[0].AmountMinor = -1 }, CodeInvalid},
		{"payout at cap", func(r *Records) { r.Payouts[0].AmountMinor = maxAmount }, ""},
		{
			"payout over cap",
			func(r *Records) { r.Payouts[0].AmountMinor = maxAmount + 1 },
			CodeInvalid,
		},
		{"future purchase", func(r *Records) { r.Purchases[0].BoughtOn = testFuture }, CodeInvalid},
		{"future refund", func(r *Records) { r.Refunds[0].RefundedOn = testFuture }, CodeInvalid},
		{"future payout", func(r *Records) { r.Payouts[0].PaidOutOn = testFuture }, CodeInvalid},
		{"impossible date", func(r *Records) { r.Payments[0].PaidOn = "2025-02-29" }, CodeInvalid},
		{
			"missing payout person",
			func(r *Records) { r.Payouts[0].PersonID = "other" },
			CodeNotFound,
		},
		{
			"missing refund purchase",
			func(r *Records) { r.Refunds[0].PurchaseID = "other" },
			CodeNotFound,
		},
		{
			"ID shared with settings",
			func(r *Records) { r.People[0].ID = SettingsID },
			CodeDuplicateID,
		},
		{"archived person", func(r *Records) { r.People[0].Archived = true }, ""},
		{"due date after today", func(r *Records) { r.Purchases[0].DueDate = new(testFuture) }, ""},
		{"refund on purchase day", func(r *Records) { r.Refunds[0].RefundedOn = testEarlier }, ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			records := baselineRecords()
			test.edit(&records)
			assertRule(t, ValidateRecords(&records, testToday), test.code)
		})
	}
}

func TestScheduleRules(t *testing.T) {
	t.Parallel()

	tests := []struct {
		edit  func(*Purchase)
		name  string
		valid bool
	}{
		{name: "valid installments", edit: func(_ *Purchase) {}, valid: true},
		{name: "unknown plan", edit: func(p *Purchase) { p.Plan = "" }, valid: false},
		{
			name:  "once with installment fields",
			edit:  func(p *Purchase) { p.Plan = PlanOnce },
			valid: false,
		},
		{
			name:  "installments with dueDate",
			edit:  func(p *Purchase) { p.DueDate = new(testFuture) },
			valid: false,
		},
		{name: "nil count", edit: func(p *Purchase) { p.Count = nil }, valid: false},
		{name: "nil first due", edit: func(p *Purchase) { p.FirstDue = nil }, valid: false},
		{name: "nil due day", edit: func(p *Purchase) { p.DueDay = nil }, valid: false},
		{name: "due day zero", edit: func(p *Purchase) { p.DueDay = new(0) }, valid: false},
		{name: "due day 32", edit: func(p *Purchase) { p.DueDay = new(32) }, valid: false},
		{
			name:  "last date over four-digit range",
			edit:  func(p *Purchase) { p.FirstDue = new("9999-11-30") },
			valid: false,
		},
		{
			name:  "leading zeros required",
			edit:  func(p *Purchase) { p.FirstDue = new("2025-9-30") },
			valid: false,
		},
		{
			name:  "invalid century leap day",
			edit:  func(p *Purchase) { p.FirstDue = new("1900-02-29") },
			valid: false,
		},
		{
			name:  "valid century leap day",
			edit:  func(p *Purchase) { p.FirstDue = new("2000-02-29") },
			valid: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			purchase := installmentPurchase(10_000, 3, 31, "2025-09-30")
			test.edit(&purchase)

			_, err := BuildSchedule(&purchase)
			if (err == nil) != test.valid {
				t.Fatalf("schedule error = %v, valid = %v", err, test.valid)
			}
		})
	}
}

func TestSettingsChanges(t *testing.T) {
	t.Parallel()

	tests := []struct {
		edit   func(*Settings)
		name   string
		code   string
		change Change
		before bool
		after  bool
	}{
		{
			name:   "setup",
			change: changeFor(KindCreate, TypeSettings, SettingsID),
			before: false,
			after:  true,
			edit:   nil,
			code:   "",
		},
		{
			name:   "duplicate setup",
			change: changeFor(KindCreate, TypeSettings, SettingsID),
			before: true,
			after:  true,
			edit:   nil,
			code:   CodeDuplicateID,
		},
		{
			name:   "no setup",
			change: changeFor(KindCreate, TypePerson, testPerson),
			before: false,
			after:  false,
			edit:   nil,
			code:   CodeNotSetup,
		},
		{
			name:   "update before setup",
			change: changeFor(KindUpdate, TypeSettings, SettingsID),
			before: false,
			after:  true,
			edit:   nil,
			code:   CodeNotSetup,
		},
		{
			name:   "delete before setup",
			change: changeFor(KindDelete, TypeSettings, SettingsID),
			before: false,
			after:  false,
			edit:   nil,
			code:   CodeNotSetup,
		},
		{
			name:   "delete settings",
			change: changeFor(KindDelete, TypeSettings, SettingsID),
			before: true,
			after:  false,
			edit:   nil,
			code:   CodeInvalid,
		},
		{
			name:   "change zone and metadata",
			change: changeFor(KindUpdate, TypeSettings, SettingsID),
			before: true,
			after:  true,
			edit:   func(s *Settings) { s.TimeZone, s.Version = "Europe/Istanbul", "next" },
			code:   "",
		},
		{
			name:   "change currency",
			change: changeFor(KindUpdate, TypeSettings, SettingsID),
			before: true,
			after:  true,
			edit:   func(s *Settings) { s.Currency = "EUR" },
			code:   CodeInvalid,
		},
		{
			name:   "change ID",
			change: changeFor(KindUpdate, TypeSettings, SettingsID),
			before: true,
			after:  true,
			edit:   func(s *Settings) { s.ID = "new" },
			code:   CodeInvalid,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			before, after := baselineRecords(), baselineRecords()
			if !test.before {
				before.Settings = nil
			}

			if !test.after {
				after.Settings = nil
			}

			if test.edit != nil {
				test.edit(after.Settings)
			}

			after.Payments[0].PaidOn = testFuture
			assertRule(t, ValidateChange(&before, &after, test.change, testToday), test.code)
		})
	}
}

func TestDependentRecordChanges(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		change   Change
		edit     func(before, after *Records)
		code     string
		blocking []string
	}{
		{
			name: "unrelated invalid record", change: changeFor(KindUpdate, TypePerson, testPerson),
			edit: func(_, after *Records) { after.Purchases[0].Item = "" }, code: "", blocking: nil,
		},
		{
			name:   "unchanged future payment",
			change: changeFor(KindUpdate, TypePayment, testPayment),
			edit: func(before, after *Records) {
				before.Payments[0].PaidOn, after.Payments[0].PaidOn = testFuture, testFuture
			},
			code:     "",
			blocking: nil,
		},
		{
			name:     "changed future payment",
			change:   changeFor(KindUpdate, TypePayment, testPayment),
			edit:     func(_, after *Records) { after.Payments[0].PaidOn = testFuture },
			code:     CodeInvalid,
			blocking: nil,
		},
		{
			name:   "unchanged future refund dependency",
			change: changeFor(KindUpdate, TypePurchase, testPurchase),
			edit: func(before, after *Records) {
				before.Refunds[0].RefundedOn, after.Refunds[0].RefundedOn = testFuture, testFuture
			},
			code:     "",
			blocking: nil,
		},
		{
			name:   "purchase date makes refund too early",
			change: changeFor(KindUpdate, TypePurchase, testPurchase),
			edit: func(before, after *Records) {
				before.Refunds[0].RefundedOn, after.Refunds[0].RefundedOn = testEarlier, testEarlier
				after.Purchases[0].BoughtOn = testToday
			},
			code:     CodeInvalid,
			blocking: nil,
		},
		{
			name:     "refund can equal total",
			change:   changeFor(KindUpdate, TypeRefund, testRefund),
			edit:     func(_, after *Records) { after.Refunds[0].AmountMinor = after.Purchases[0].TotalMinor },
			code:     "",
			blocking: nil,
		},
		{
			name:   "refund aggregate exceeds total",
			change: changeFor(KindUpdate, TypeRefund, testRefund),
			edit: func(before, after *Records) {
				second := before.Refunds[0]
				second.ID = "second-refund"
				before.Refunds, after.Refunds = append(
					before.Refunds,
					second,
				), append(
					after.Refunds,
					second,
				)
				after.Refunds[0].AmountMinor = 401
			},
			code:     CodeRefundsExceedTotal,
			blocking: nil,
		},
		{
			name:   "refund purchase immutable",
			change: changeFor(KindUpdate, TypeRefund, testRefund),
			edit: func(before, after *Records) {
				second := before.Purchases[0]
				second.ID = "second-purchase"
				before.Purchases, after.Purchases = append(
					before.Purchases,
					second,
				), append(
					after.Purchases,
					second,
				)
				after.Refunds[0].PurchaseID = second.ID
			},
			code:     CodeInvalid,
			blocking: nil,
		},
		{
			name: "blocked purchase", change: changeFor(KindDelete, TypePurchase, testPurchase),
			edit: func(_, after *Records) { after.Purchases = nil }, code: CodePurchaseHasRefunds,
			blocking: []string{testRefund},
		},
		{
			name: "blocked person", change: changeFor(KindDelete, TypePerson, testPerson),
			edit: func(_, after *Records) { after.People = nil }, code: CodePersonHasRecords,
			blocking: []string{testPayment, testPayout, testPurchase},
		},
		{
			name:     "already returned cannot bypass future date",
			change:   alreadyReturnedChange(),
			edit:     func(_, after *Records) { after.Payouts[0].AmountMinor, after.Payouts[0].PaidOutOn = 9999, testFuture },
			code:     CodeInvalid,
			blocking: nil,
		},
		{
			name:     "decrease overdrawn payout",
			change:   changeFor(KindUpdate, TypePayout, testPayout),
			edit:     func(before, after *Records) { before.Payouts[0].AmountMinor, after.Payouts[0].AmountMinor = 2000, 1500 },
			code:     "",
			blocking: nil,
		},
		{
			name:     "create clashes across types",
			change:   changeFor(KindCreate, TypeRefund, testPayout),
			edit:     func(_, after *Records) { after.Refunds[0].ID = testPayout },
			code:     CodeDuplicateID,
			blocking: nil,
		},
		{
			name: "update of missing record", change: changeFor(KindUpdate, TypePayment, "gone"),
			edit: func(_, _ *Records) {}, code: CodeConflict, blocking: nil,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			before, after := baselineRecords(), baselineRecords()
			test.edit(&before, &after)
			assertRule(
				t,
				ValidateChange(&before, &after, test.change, testToday),
				test.code,
				test.blocking...)
		})
	}
}

func alreadyReturnedChange() Change {
	change := changeFor(KindUpdate, TypePayout, testPayout)
	change.AlreadyReturned = true

	return change
}

func TestAdjustmentsAndAllocationOrder(t *testing.T) {
	t.Parallel()

	purchase := installmentPurchase(60_000, 3, 31, "2025-02-28")
	matching := baselineRecords().Refunds[0]
	matching.AmountMinor = 25_000
	unrelated := matching
	unrelated.PurchaseID = "another"
	refunds := []Refund{matching, unrelated}

	amounts, err := AdjustedSchedule(&purchase, refunds)
	if err != nil {
		t.Fatal(err)
	}

	for i, want := range []int64{20_000, 15_000, 0} {
		if amounts[i].BaseMinor != 20_000 || amounts[i].AdjustedMinor != want {
			t.Errorf("installment %d = %+v, want adjusted amount %d", i, amounts[i], want)
		}
	}

	entries := make([]allocationEntry, 0, 7)
	for _, item := range []struct {
		dueOn    *string
		id       string
		boughtOn string
		seq      int
	}{
		{id: "b", boughtOn: testEarlier, dueOn: new(testToday), seq: 1},
		{id: "a", boughtOn: testEarlier, dueOn: nil, seq: 1},
		{id: "a", boughtOn: testEarlier, dueOn: new(testToday), seq: 2},
		{id: "one", boughtOn: testToday, dueOn: new(testEarlier), seq: 1},
		{id: "b", boughtOn: testToday, dueOn: nil, seq: 1},
		{id: "a", boughtOn: testEarlier, dueOn: new(testToday), seq: 1},
		{id: "0", boughtOn: testToday, dueOn: new(testToday), seq: 1},
	} {
		entries = append(entries, allocationEntry{
			amount: scheduledAmount(
				item.id,
				item.seq,
				100,
				item.dueOn,
			),
			boughtOn: item.boughtOn,
		})
	}

	if remaining := allocate(entries, 175); remaining != 0 {
		t.Fatalf("remaining = %d, want 0", remaining)
	}

	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		ids = append(ids, entry.amount.PurchaseID)
	}

	if !slices.Equal(ids, []string{"one", "a", "a", "b", "0", "a", "b"}) ||
		entries[1].amount.Sequence != 1 {
		t.Errorf("allocation order = %v", entries)
	}
}
