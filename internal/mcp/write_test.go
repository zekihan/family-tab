package mcp

import (
	"maps"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
)

func TestAddPurchaseOnce(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)

	result := env.mustCall("add_purchase", map[string]any{
		"personId": mom, "item": "  Vacuum   cleaner ", "price": "1.299,90",
	})

	stored := env.purchase(text(t, result, "purchase", "id"))

	if stored.Source != ledger.SourceAgent || stored.Plan != ledger.PlanOnce ||
		stored.BoughtOn != "2026-11-22" || stored.DueDate != nil || stored.Count != nil ||
		stored.FirstDue != nil || stored.DueDay != nil || stored.TotalMinor != 129990 ||
		stored.Item != "Vacuum cleaner" {
		t.Fatalf("stored purchase = %+v", stored)
	}

	expect(t, result, map[string]any{
		"purchase.totalMinor":    129990,
		"purchase.total":         "1.299,90 TL",
		"purchase.source":        "agent",
		"purchase.personName":    "Mom",
		"balance.leftToPay":      "1.299,90 TL",
		"balance.leftToPayMinor": 129990,
		"person.name":            "Mom",
	})
}

func TestAddPurchaseDueDates(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	dad := env.addPerson("Dad", new(15))

	for keyword, want := range map[string]string{
		"payday": "2026-12-15", "endOfMonth": "2026-11-30", "inTwoWeeks": "2026-12-06",
		"2027-01-10": "2027-01-10",
	} {
		result := env.mustCall("add_purchase", map[string]any{
			"personId": dad, "item": "Shoes", "price": "100", "dueDate": keyword,
		})

		got := env.purchase(text(t, result, "purchase", "id"))
		if got.DueDate == nil || *got.DueDate != want {
			t.Errorf("dueDate %q stored %v, want %s", keyword, got.DueDate, want)
		}
	}
}

func TestAddPurchaseMovesUnsetBoughtOnToEarlierDue(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	dad := env.addPerson("Dad", nil)

	for _, input := range []map[string]any{
		{"plan": "once", "dueDate": "2026-10-15"},
		{"plan": "installments", "firstDue": "2026-10-15"},
	} {
		input["personId"], input["item"], input["price"] = dad, "Phone", "600"

		got := env.purchase(text(t, env.mustCall("add_purchase", input), "purchase", "id"))
		if got.BoughtOn != "2026-10-15" {
			t.Errorf("%v stored boughtOn %s, want 2026-10-15", input, got.BoughtOn)
		}
	}

	env.mustFail("add_purchase", map[string]any{
		"personId": dad, "item": "Phone", "price": "600", "boughtOn": "2026-11-01",
		"dueDate": "2026-10-15",
	}, "invalid")
}

func TestAddPurchaseValidation(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)

	base := func(extra map[string]any) map[string]any {
		args := map[string]any{"personId": mom, "item": "Shoes", "price": "100"}
		maps.Copy(args, extra)

		return args
	}

	env.mustFail("add_purchase", base(map[string]any{"dueDate": "payday"}), "no payday")
	env.mustFail("add_purchase", base(map[string]any{"dueDate": "soon"}), "dueDate must be")
	env.mustFail(
		"add_purchase",
		base(map[string]any{"count": 3}),
		"only apply to plan installments",
	)
	env.mustFail("add_purchase", base(map[string]any{"firstDue": "2026-12-01"}),
		"only apply to plan installments")
	env.mustFail("add_purchase", base(map[string]any{"lastDayOfMonth": true}),
		"only apply to plan installments")
	env.mustFail("add_purchase", base(map[string]any{"price": "100,5555"}), "not a valid amount")
	env.mustFail("add_purchase", base(map[string]any{"price": "-5"}), "not a valid amount")
	env.mustFail("add_purchase", base(map[string]any{"boughtOn": "22.11.2026"}), "YYYY-MM-DD")
	env.mustFail(
		"add_purchase",
		base(map[string]any{"boughtOn": "2026-11-23"}),
		"invalid",
		"future",
	)
	env.mustFail("add_purchase", base(map[string]any{"personId": "nobody"}), "list_people")
	env.mustFail("add_purchase", base(map[string]any{"plan": "monthly"}), "plan must be")
	env.mustFail("add_purchase", base(map[string]any{"item": "   "}), "item must not be empty")
	env.mustFail(
		"add_purchase",
		base(map[string]any{"boughtOn": "2026-11-22", "dueDate": "2026-11-01"}),
		"invalid",
	)

	if len(env.snapshot().Purchases) != 0 {
		t.Fatal("a rejected purchase was stored")
	}
}

func TestAddPurchaseInstallments(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)
	dad := env.addPerson("Dad", new(5))

	type want struct {
		firstDue string
		dueDay   int
		count    int
	}

	cases := []struct {
		name   string
		person string
		args   map[string]any
		want   want
	}{
		{"no payday", mom, map[string]any{}, want{"2026-12-22", 22, 6}},
		{"payday", dad, map[string]any{}, want{"2026-12-05", 5, 6}},
		{"count", dad, map[string]any{"count": 3}, want{"2026-12-05", 5, 3}},
		{"explicit date", mom, map[string]any{"firstDue": "2026-12-17"}, want{"2026-12-17", 17, 6}},
		{
			"flag ignored when not the last day", mom,
			map[string]any{"firstDue": "2026-12-30", "lastDayOfMonth": true},
			want{"2026-12-30", 30, 6},
		},
		{
			"last day without flag", mom,
			map[string]any{"firstDue": "2026-12-31"},
			want{"2026-12-31", 31, 6},
		},
		{
			"last day with flag", mom,
			map[string]any{"firstDue": "2026-11-30", "lastDayOfMonth": true},
			want{"2026-11-30", 31, 6},
		},
		{
			"february last day", mom,
			map[string]any{"firstDue": "2027-02-28", "lastDayOfMonth": true},
			want{"2027-02-28", 31, 6},
		},
		{
			"february without flag", mom,
			map[string]any{"firstDue": "2027-02-28"},
			want{"2027-02-28", 28, 6},
		},
	}

	for _, test := range cases {
		args := map[string]any{
			"personId": test.person,
			"item":     "Washing machine",
			"price":    "12.000",
			"plan":     "installments",
		}
		maps.Copy(args, test.args)

		result := env.mustCall("add_purchase", args)
		stored := env.purchase(text(t, result, "purchase", "id"))

		if stored.Plan != ledger.PlanInstallments || stored.Source != ledger.SourceAgent ||
			stored.DueDate != nil || stored.FirstDue == nil || stored.DueDay == nil ||
			stored.Count == nil || *stored.FirstDue != test.want.firstDue ||
			*stored.DueDay != test.want.dueDay || *stored.Count != test.want.count {
			t.Errorf("%s: stored %+v", test.name, stored)
		}

		if count(t, result, "purchase", "installments") != test.want.count {
			t.Errorf("%s: schedule = %v", test.name, field(t, result, "purchase", "installments"))
		}
	}

	installments := func(extra map[string]any) map[string]any {
		args := map[string]any{
			"personId": mom, "item": "TV", "price": "5000", "plan": "installments",
		}
		maps.Copy(args, extra)

		return args
	}

	env.mustFail("add_purchase", installments(map[string]any{"dueDate": "2026-12-01"}),
		"dueDate only applies to plan once")
	env.mustFail("add_purchase", installments(map[string]any{"lastDayOfMonth": true}),
		"explicit firstDue")
	env.mustFail("add_purchase", installments(map[string]any{"count": 1}), "invalid")
	env.mustFail("add_purchase", installments(map[string]any{"firstDue": "next month"}),
		"firstDue must be")
}

func TestAddPurchaseForArchivedPerson(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)
	env.update(
		ledger.TypePerson,
		mom,
		env.snapshot().People[0].Version,
		map[string]any{"archived": true},
	)

	env.mustFail("add_purchase", map[string]any{
		"personId": mom, "item": "TV", "price": "5000",
	}, "archived_person")
}

func TestRecordPayment(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)
	env.addAppPurchase(mom, "Phone", 800000, "2026-11-01", "")

	result := env.mustCall("record_payment", map[string]any{
		"personId": mom, "amount": "5.000", "note": " first part ",
	})

	expect(t, result, map[string]any{
		"payment.amountMinor":    500000,
		"payment.amount":         "5.000,00 TL",
		"payment.paidOn":         "2026-11-22",
		"payment.source":         "agent",
		"payment.personName":     "Mom",
		"balance.leftToPayMinor": 300000,
		"balance.leftToPay":      "3.000,00 TL",
	})

	payments := env.snapshot().Payments
	if len(payments) != 1 || payments[0].AmountMinor != 500000 ||
		payments[0].Source != ledger.SourceAgent || payments[0].Note == nil ||
		*payments[0].Note != "first part" {
		t.Fatalf("payments = %+v", payments)
	}

	env.mustFail(
		"record_payment",
		map[string]any{"personId": mom, "amount": "0"},
		"not a valid amount",
	)
	env.mustFail(
		"record_payment",
		map[string]any{"personId": mom, "amount": "12 TL"},
		"not a valid amount",
	)
	env.mustFail("record_payment", map[string]any{
		"personId": mom, "amount": "10", "paidOn": "2026-12-01",
	}, "invalid")
}

func TestAddRefund(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)
	purchase := env.addAppPurchase(mom, "Phone", 10000, "2026-11-01", "")

	result := env.mustCall("add_refund", map[string]any{"purchaseId": purchase, "amount": "30"})

	expect(t, result, map[string]any{
		"refund.amountMinor":       3000,
		"refund.source":            "agent",
		"refund.item":              "Phone",
		"purchase.refundedMinor":   3000,
		"purchase.refundableMinor": 7000,
		"purchase.leftMinor":       7000,
		"purchase.refundable":      "70,00 TL",
		"balance.leftToPayMinor":   7000,
	})

	refunds := env.snapshot().Refunds
	if len(refunds) != 1 || refunds[0].Source != ledger.SourceAgent ||
		refunds[0].RefundedOn != "2026-11-22" {
		t.Fatalf("refunds = %+v", refunds)
	}

	env.mustFail("add_refund", map[string]any{"purchaseId": purchase, "amount": "80"},
		"refunds_exceed_total")
	env.mustFail(
		"add_refund",
		map[string]any{"purchaseId": "nope", "amount": "1"},
		"find_purchases",
	)
}

func TestAliases(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil, "Anne")
	dad := env.addPerson("Dad", nil)

	result := env.mustCall("add_alias", map[string]any{"personId": dad, "alias": "  Baba  "})
	if count(t, result, "person", "aliases") != 1 ||
		text(t, result, "person", "aliases", "0") != "Baba" {
		t.Fatalf("result = %v", result)
	}

	env.mustFail(
		"add_alias",
		map[string]any{"personId": dad, "alias": "ANNE"},
		"alias_conflict",
		mom,
	)
	env.mustFail("add_alias", map[string]any{"personId": dad, "alias": "babA"}, "invalid")
	env.mustFail("add_alias", map[string]any{"personId": dad, "alias": "   "}, "must not be empty")

	result = env.mustCall("add_alias", map[string]any{"personId": dad, "alias": "Babacığım"})
	if count(t, result, "person", "aliases") != 2 {
		t.Fatalf("result = %v", result)
	}

	result = env.mustCall("remove_alias", map[string]any{"personId": dad, "alias": "BABACIGIM"})
	if count(t, result, "person", "aliases") != 1 ||
		text(t, result, "person", "aliases", "0") != "Baba" {
		t.Fatalf("result = %v", result)
	}

	env.mustFail("remove_alias", map[string]any{"personId": dad, "alias": "Anne"},
		"no alias matching", "Baba")

	for _, person := range env.snapshot().People {
		if person.ID == dad && (len(person.Aliases) != 1 || person.Aliases[0] != "Baba") {
			t.Fatalf("stored aliases = %v", person.Aliases)
		}
	}
}

func (env *harness) restoreCurrent() {
	env.t.Helper()

	snapshot := env.snapshot()

	result, err := env.svc.Restore(env.t.Context(), &protocol.RestoreRequest{
		RawBackup: nil, OpID: uuid.NewString(), ExpectedRevision: snapshot.Revision,
		Backup: protocol.BackupFile{
			Format: protocol.BackupFormat, FormatVersion: protocol.BackupFormatVersion,
			ExportedAt: env.clock.Now().UTC().Format(time.RFC3339), Currency: ledger.CurrencyTRY,
			TimeZone: snapshot.Settings.TimeZone, People: snapshot.People,
			Purchases: []ledger.Purchase{}, Payments: []ledger.Payment{},
			Refunds: []ledger.Refund{}, Payouts: []ledger.Payout{},
			Unapplied: []protocol.UnappliedOperation{},
		},
	})
	if err != nil || result.Status != protocol.StatusApplied {
		env.t.Fatalf("restore = %+v, %v", result, err)
	}
}

func TestWriteRetriesOnceAfterRestore(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)
	svc := &service{ledger: env.svc, now: env.clock.Now}
	before := env.snapshot().Generation

	build := func(restores int) func(*state) (*change, error) {
		calls := 0

		return func(st *state) (*change, error) {
			calls++
			if calls <= restores {
				env.restoreCurrent()
			}

			id := uuid.NewString()

			return createChange(ledger.TypePayment, id, &paymentCreate{
				Note: nil, ID: id, PersonID: mom, PaidOn: st.today, AmountMinor: 100,
			}), nil
		}
	}

	after, err := svc.write(t.Context(), build(1))
	if err != nil || len(after.snapshot.Payments) != 1 || after.snapshot.Generation == before {
		t.Fatalf("write after one restore = %+v, %v", after, err)
	}

	_, err = svc.write(t.Context(), build(2))
	if err == nil || !strings.Contains(err.Error(), "generation_mismatch") ||
		!strings.Contains(err.Error(), "restored") {
		t.Fatalf("write with repeated restores = %v", err)
	}
}
