package mcp

import (
	"testing"

	"github.com/zekihan/family-tab/internal/ledger"
)

func TestToolsFailBeforeSetup(t *testing.T) {
	t.Parallel()

	env := newHarness(t)

	env.mustFail("list_people", nil, "not set up")
	env.mustFail("get_overview", nil, "not set up")
	env.mustFail("add_purchase", map[string]any{
		"personId": "x", "item": "Phone", "price": "100",
	}, "not set up")
}

func TestToolList(t *testing.T) {
	t.Parallel()

	env := newHarness(t)

	tools, err := env.session.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}

	names := map[string]bool{}

	for _, tool := range tools.Tools {
		names[tool.Name] = true

		if tool.Description == "" {
			t.Errorf("%s has no description", tool.Name)
		}
	}

	for _, name := range []string{
		"list_people", "find_person", "get_balance", "get_statement", "get_overview", "coming_up",
		"find_purchases", "check_purchases", "add_purchase", "record_payment", "add_refund",
		"add_alias", "remove_alias", "undo",
	} {
		if !names[name] {
			t.Errorf("tool %s is not registered", name)
		}
	}

	if len(names) != 14 {
		t.Errorf("registered %d tools, want 14", len(names))
	}
}

func TestFindPersonTool(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	env.addPerson("Ayşe", nil)
	env.addPerson("Dad", nil, "Baba")

	for _, query := range []string{"AYŞE", "Ayse", "ayşe"} {
		result := env.mustCall("find_person", map[string]any{"query": query})
		if text(t, result, "exact", "name") != "Ayşe" || count(t, result, "suggestions") != 0 {
			t.Errorf("%q: result = %v", query, result)
		}
	}

	result := env.mustCall("find_person", map[string]any{"query": "babam"})
	if field(t, result, "exact") != nil || count(t, result, "suggestions") != 1 ||
		text(t, result, "suggestions", "0", "name") != "Dad" {
		t.Fatalf("babam: result = %v", result)
	}

	result = env.mustCall("find_person", map[string]any{"query": "zeynep"})
	if field(t, result, "exact") != nil || count(t, result, "suggestions") != 0 {
		t.Fatalf("zeynep: result = %v", result)
	}

	env.mustFail("find_person", map[string]any{"query": "  "}, "must not be empty")

	people := env.mustCall("list_people", nil)
	if count(t, people, "people") != 2 {
		t.Fatalf("people = %v", people)
	}
}

func TestCheckPurchases(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)
	dad := env.addPerson("Dad", nil)
	env.addAppPurchase(mom, "Kettle", 129990, "2026-11-20", "")
	env.addAppPurchase(dad, "Blender", 129990, "2026-11-17", "")
	env.addAppPurchase(dad, "Lamp", 5000, "2026-11-20", "")

	result := env.mustCall("check_purchases", map[string]any{"items": []any{
		map[string]any{"item": "Kettle", "price": "1.299,90", "boughtOn": "2026-11-20"},
		map[string]any{"item": "Kettle again", "price": "1299,90", "boughtOn": "2026-11-23"},
		map[string]any{"item": "Kettle later", "price": "1299.90", "boughtOn": "2026-11-24"},
		map[string]any{"item": "Other price", "price": "1300", "boughtOn": "2026-11-20"},
		map[string]any{"item": "Earlier", "price": "1299,90", "boughtOn": "2026-11-13"},
	}})

	for index, want := range []int{2, 1, 0, 0, 0} {
		path := []string{"results", string(rune('0' + index)), "possibleDuplicates"}
		if got := count(t, result, path...); got != want {
			t.Errorf("item %d: %d duplicates, want %d: %v", index, got, want, result)
		}
	}

	expect(t, result, map[string]any{
		"results.0.possibleDuplicates.0.personName": "Dad",
		"results.0.possibleDuplicates.1.personName": "Mom",
		"results.1.possibleDuplicates.0.item":       "Kettle",
		"results.0.priceMinor":                      129990,
		"results.0.price":                           "1.299,90 TL",
	})

	env.mustFail("check_purchases", map[string]any{"items": []any{
		map[string]any{"item": "Kettle", "price": "free", "boughtOn": "2026-11-20"},
	}}, "items[0]", "not a valid amount")
	env.mustFail("check_purchases", map[string]any{"items": []any{
		map[string]any{"item": "Kettle", "price": "10", "boughtOn": "20.11.2026"},
	}}, "items[0]", "YYYY-MM-DD")
	env.mustFail("check_purchases", map[string]any{"items": []any{}}, "at least one")
}

func TestGetStatementPartiallyPaidInstallments(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)

	machine := "11111111-1111-4111-8111-111111111111"
	env.create(ledger.TypePurchase, machine, map[string]any{
		"id": machine, "personId": mom, "item": "Washing machine", "totalMinor": 30000,
		"boughtOn": "2026-10-01", "plan": ledger.PlanInstallments, "dueDate": nil, "count": 3,
		"firstDue": "2026-10-15", "dueDay": 15, "note": "gift",
	})
	env.addAppPurchase(mom, "Old toy", 1000, "2026-09-01", "2026-09-15")
	env.addAppPayment(mom, 16000, "2026-11-10")

	result := env.mustCall("get_statement", map[string]any{"personId": mom})

	if count(t, result, "purchases") != 1 ||
		count(t, result, "purchases", "0", "installments") != 2 {
		t.Fatalf("default statement = %v", result)
	}

	expect(t, result, map[string]any{
		"today":                                     "2026-11-22",
		"purchases.0.item":                          "Washing machine",
		"purchases.0.plan":                          "installments",
		"purchases.0.totalMinor":                    30000,
		"purchases.0.total":                         "300,00 TL",
		"purchases.0.leftMinor":                     15000,
		"purchases.0.left":                          "150,00 TL",
		"purchases.0.refundedMinor":                 0,
		"purchases.0.source":                        "app",
		"purchases.0.note":                          "gift",
		"balance.leftToPayMinor":                    15000,
		"balance.dueByTodayMinor":                   5000,
		"purchases.0.installments.0.sequence":       2,
		"purchases.0.installments.0.dueOn":          "2026-11-15",
		"purchases.0.installments.0.adjustedMinor":  10000,
		"purchases.0.installments.0.paidMinor":      5000,
		"purchases.0.installments.0.remainingMinor": 5000,
		"purchases.0.installments.0.remaining":      "50,00 TL",
		"purchases.0.installments.0.overdue":        true,
		"purchases.0.installments.1.dueOn":          "2026-12-15",
		"purchases.0.installments.1.remainingMinor": 10000,
		"purchases.0.installments.1.overdue":        false,
	})

	full := env.mustCall("get_statement", map[string]any{"personId": mom, "includePaid": true})
	if count(t, full, "purchases") != 2 || count(t, full, "purchases", "1", "installments") != 3 {
		t.Fatalf("full statement = %v", full)
	}

	expect(t, full, map[string]any{
		"purchases.1.installments.0.remainingMinor": 0,
		"purchases.1.installments.0.paidMinor":      10000,
		"purchases.1.installments.0.overdue":        false,
	})

	since := env.mustCall("get_statement", map[string]any{
		"personId": mom, "includePaid": true, "since": "2026-10-01",
	})
	if count(t, since, "purchases") != 1 {
		t.Fatalf("since statement = %v", since)
	}

	env.mustFail(
		"get_statement",
		map[string]any{"personId": mom, "since": "yesterday"},
		"YYYY-MM-DD",
	)
	env.mustFail("get_statement", map[string]any{"personId": "nobody"}, "list_people")

	balance := env.mustCall("get_balance", map[string]any{"personId": mom})

	expect(t, balance, map[string]any{
		"balance.status.kind":           "dueByToday",
		"balance.status.amountMinor":    5000,
		"paymentChips.0.kind":           "dueByToday",
		"paymentChips.0.amountMinor":    5000,
		"paymentChips.0.amount":         "50,00 TL",
		"paymentChips.1.kind":           "throughNextDue",
		"paymentChips.1.amountMinor":    15000,
		"paymentChips.2.kind":           "everything",
		"balance.earliestUnpaidFuture":  "2026-12-15",
		"balance.paymentsReceivedMinor": 16000,
	})
}

func TestOverviewComingUpAndFindPurchases(t *testing.T) {
	t.Parallel()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)
	dad := env.addPerson("Dad", nil)
	zehra := env.addPerson("Zehra", nil)

	env.addAppPurchase(mom, "Phone", 5000, "2026-11-01", "2026-11-10")
	env.addAppPurchase(dad, "Şemsiye", 9000, "2026-11-05", "")
	env.addAppPurchase(dad, "Bag", 100, "2026-11-09", "")
	env.addAppPurchase(zehra, "Sofa", 20000, "2026-11-20", "2026-12-01")

	overview := env.mustCall("get_overview", map[string]any{})

	expect(t, overview, map[string]any{
		"people.0.person.name":             "Mom",
		"people.0.balance.dueByTodayMinor": 5000,
		"people.1.person.name":             "Zehra",
		"people.2.person.name":             "Dad",
		"totals.leftToPayMinor":            34100,
		"totals.leftToPay":                 "341,00 TL",
		"totals.dueNextMonthMinor":         20000,
		"people.1.balance.status.kind":     "nextDate",
		"people.1.balance.status.date":     "2026-12-01",
	})

	upcoming := env.mustCall("coming_up", map[string]any{})
	if count(t, upcoming, "entries") != 1 {
		t.Fatalf("coming up = %v", upcoming)
	}

	expect(t, upcoming, map[string]any{
		"entries.0.item": "Sofa", "entries.0.personName": "Zehra", "entries.0.dueOn": "2026-12-01",
		"entries.0.remaining": "200,00 TL",
	})

	found := env.mustCall("find_purchases", map[string]any{"query": "SEMSIYE"})
	if count(t, found, "purchases") != 1 {
		t.Fatalf("find = %v", found)
	}

	expect(t, found, map[string]any{
		"purchases.0.item": "Şemsiye", "purchases.0.refundableMinor": 9000,
		"purchases.0.personName": "Dad", "truncated": false,
	})

	found = env.mustCall("find_purchases", map[string]any{"personId": dad})
	if count(t, found, "purchases") != 2 || text(t, found, "purchases", "0", "item") != "Bag" {
		t.Fatalf("find by person = %v", found)
	}

	found = env.mustCall(
		"find_purchases",
		map[string]any{"since": "2026-11-05", "until": "2026-11-09"},
	)
	if count(t, found, "purchases") != 2 {
		t.Fatalf("find by date = %v", found)
	}

	env.mustFail("find_purchases", map[string]any{"until": "x"}, "YYYY-MM-DD")
}
