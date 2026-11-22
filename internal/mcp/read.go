package mcp

import (
	"cmp"
	"context"
	"slices"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/zekihan/family-tab/internal/ledger"
)

const (
	findPurchasesLimit   = 50
	duplicateWindowDays  = 3
	maxCheckedItems      = 100
	unsetDate            = ""
	checkPurchasesNoItem = "items must list at least one item."
)

type emptyInput struct{}

type listPeopleResult struct {
	People []personResult `json:"people"`
}

func (svc *service) listPeople(
	ctx context.Context, _ *sdk.CallToolRequest, _ emptyInput,
) (*sdk.CallToolResult, listPeopleResult, error) {
	st, err := svc.load(ctx)
	if err != nil {
		return nil, listPeopleResult{}, err
	}

	return nil, listPeopleResult{People: newPersonResults(st.snapshot.People)}, nil
}

type findPersonInput struct {
	Query string `json:"query" jsonschema:"The name or wording the buyer used for the person."`
}

type findPersonResult struct {
	Exact       *personResult  `json:"exact"`
	Suggestions []personResult `json:"suggestions"`
}

func (svc *service) findPerson(
	ctx context.Context, _ *sdk.CallToolRequest, input findPersonInput,
) (*sdk.CallToolResult, findPersonResult, error) {
	st, err := svc.load(ctx)
	if err != nil {
		return nil, findPersonResult{}, err
	}

	if ledger.NormalizeName(input.Query) == "" {
		return nil, findPersonResult{}, fail("query must not be empty.")
	}

	exact, suggestions := findPerson(st.snapshot.People, input.Query)
	result := findPersonResult{Exact: nil, Suggestions: newPersonResults(suggestions)}

	if exact != nil {
		found := newPersonResult(exact)
		result.Exact = &found
	}

	return nil, result, nil
}

type personIDInput struct {
	PersonID string `json:"personId" jsonschema:"The person's id from list_people or find_person."`
}

type getBalanceResult struct {
	Today        string              `json:"today"`
	PaymentChips []paymentChipResult `json:"paymentChips"`
	Person       personResult        `json:"person"`
	Balance      balanceResult       `json:"balance"`
}

func (svc *service) getBalance(
	ctx context.Context, _ *sdk.CallToolRequest, input personIDInput,
) (*sdk.CallToolResult, getBalanceResult, error) {
	st, err := svc.load(ctx)
	if err != nil {
		return nil, getBalanceResult{}, err
	}

	person, err := st.person(input.PersonID)
	if err != nil {
		return nil, getBalanceResult{}, err
	}

	return nil, getBalanceResult{
		Today:        st.today,
		Person:       newPersonResult(person),
		Balance:      newBalanceResult(st.view, person.ID),
		PaymentChips: newPaymentChipResults(st.view, &st.snapshot.Records, person.ID),
	}, nil
}

type getStatementInput struct {
	PersonID    string `json:"personId"              jsonschema:"The person's id from list_people or find_person."`
	Since       string `json:"since,omitempty"       jsonschema:"Only purchases bought on or after (YYYY-MM-DD)."`
	IncludePaid bool   `json:"includePaid,omitempty" jsonschema:"Also list paid items. Default false."`
}

type getStatementResult struct {
	Today     string           `json:"today"`
	Purchases []purchaseResult `json:"purchases"`
	Person    personResult     `json:"person"`
	Balance   balanceResult    `json:"balance"`
}

func (svc *service) getStatement(
	ctx context.Context, _ *sdk.CallToolRequest, input getStatementInput,
) (*sdk.CallToolResult, getStatementResult, error) {
	st, err := svc.load(ctx)
	if err != nil {
		return nil, getStatementResult{}, err
	}

	person, err := st.person(input.PersonID)
	if err != nil {
		return nil, getStatementResult{}, err
	}

	err = checkOptionalDate("since", input.Since)
	if err != nil {
		return nil, getStatementResult{}, err
	}

	schedule := scheduleUnpaid
	if input.IncludePaid {
		schedule = scheduleAll
	}

	purchases := []purchaseResult{}

	for _, purchase := range st.purchasesOf(person.ID) {
		result := st.newPurchaseResult(purchase, schedule)
		if (input.Since != unsetDate && purchase.BoughtOn < input.Since) ||
			(!input.IncludePaid && result.LeftMinor <= 0) {
			continue
		}

		purchases = append(purchases, result)
	}

	return nil, getStatementResult{
		Today:     st.today,
		Person:    newPersonResult(person),
		Balance:   newBalanceResult(st.view, person.ID),
		Purchases: purchases,
	}, nil
}

type overviewPerson struct {
	Person  personResult  `json:"person"`
	Balance balanceResult `json:"balance"`
}

type homeResult struct {
	LeftToPay         string `json:"leftToPay"`
	DueByToday        string `json:"dueByToday"`
	DueNextMonth      string `json:"dueNextMonth"`
	Credit            string `json:"credit"`
	ArchivedLeftToPay string `json:"archivedLeftToPay"`

	LeftToPayMinor         int64 `json:"leftToPayMinor"`
	DueByTodayMinor        int64 `json:"dueByTodayMinor"`
	DueNextMonthMinor      int64 `json:"dueNextMonthMinor"`
	CreditMinor            int64 `json:"creditMinor"`
	ArchivedLeftToPayMinor int64 `json:"archivedLeftToPayMinor"`
}

type getOverviewResult struct {
	Today  string           `json:"today"`
	People []overviewPerson `json:"people"`
	Totals homeResult       `json:"totals"`
}

func (svc *service) getOverview(
	ctx context.Context, _ *sdk.CallToolRequest, _ emptyInput,
) (*sdk.CallToolResult, getOverviewResult, error) {
	st, err := svc.load(ctx)
	if err != nil {
		return nil, getOverviewResult{}, err
	}

	var active []*ledger.Person

	for index := range st.snapshot.People {
		if !st.snapshot.People[index].Archived {
			active = append(active, &st.snapshot.People[index])
		}
	}

	slices.SortFunc(active, func(left, right *ledger.Person) int {
		leftBalance, rightBalance := st.view.Balances[left.ID], st.view.Balances[right.ID]

		return cmp.Or(
			cmp.Compare(rightBalance.DueByToday, leftBalance.DueByToday),
			cmp.Compare(rightBalance.LeftToPay, leftBalance.LeftToPay),
			cmp.Compare(ledger.NormalizeName(left.Name), ledger.NormalizeName(right.Name)),
			cmp.Compare(left.ID, right.ID),
		)
	})

	people := make([]overviewPerson, 0, len(active))
	for _, person := range active {
		people = append(people, overviewPerson{
			Person: newPersonResult(person), Balance: newBalanceResult(st.view, person.ID),
		})
	}

	home := st.view.Home

	return nil, getOverviewResult{
		Today: st.today,
		Totals: homeResult{
			LeftToPay: formatTRY(home.LeftToPay), DueByToday: formatTRY(home.DueByToday),
			DueNextMonth: formatTRY(home.DueNextMonth), Credit: formatTRY(home.Credit),
			ArchivedLeftToPay: formatTRY(home.ArchivedLeftToPay), LeftToPayMinor: home.LeftToPay,
			DueByTodayMinor: home.DueByToday, DueNextMonthMinor: home.DueNextMonth,
			CreditMinor: home.Credit, ArchivedLeftToPayMinor: home.ArchivedLeftToPay,
		},
		People: people,
	}, nil
}

type comingUpItem struct {
	PersonID       string `json:"personId"`
	PersonName     string `json:"personName"`
	PurchaseID     string `json:"purchaseId"`
	Item           string `json:"item"`
	DueOn          string `json:"dueOn"`
	Remaining      string `json:"remaining"`
	Sequence       int    `json:"sequence"`
	RemainingMinor int64  `json:"remainingMinor"`
	Archived       bool   `json:"archived"`
}

type comingUpResult struct {
	Today   string         `json:"today"`
	Entries []comingUpItem `json:"entries"`
}

func (svc *service) comingUp(
	ctx context.Context, _ *sdk.CallToolRequest, _ emptyInput,
) (*sdk.CallToolResult, comingUpResult, error) {
	st, err := svc.load(ctx)
	if err != nil {
		return nil, comingUpResult{}, err
	}

	entries := make([]comingUpItem, 0, len(st.view.ComingUp))

	for _, entry := range st.view.ComingUp {
		item := ""

		purchase, purchaseErr := st.purchase(entry.PurchaseID)
		if purchaseErr == nil {
			item = purchase.Item
		}

		entries = append(entries, comingUpItem{
			PersonID: entry.PersonID, PersonName: st.personName(entry.PersonID),
			PurchaseID: entry.PurchaseID, Item: item, DueOn: entry.DueOn,
			Remaining: formatTRY(entry.RemainingMinor), Sequence: entry.Sequence,
			RemainingMinor: entry.RemainingMinor, Archived: entry.Archived,
		})
	}

	return nil, comingUpResult{Today: st.today, Entries: entries}, nil
}

type findPurchasesInput struct {
	Query    string `json:"query,omitempty"    jsonschema:"Part of the item name to search for."`
	PersonID string `json:"personId,omitempty" jsonschema:"Only this person's purchases."`
	Since    string `json:"since,omitempty"    jsonschema:"Only purchases bought on or after this date (YYYY-MM-DD)."`
	Until    string `json:"until,omitempty"    jsonschema:"Only purchases bought on or before this date (YYYY-MM-DD)."`
}

func (input *findPurchasesInput) matches(purchase *ledger.Purchase) bool {
	return (input.PersonID == "" || purchase.PersonID == input.PersonID) &&
		(input.Since == unsetDate || purchase.BoughtOn >= input.Since) &&
		(input.Until == unsetDate || purchase.BoughtOn <= input.Until) &&
		strings.Contains(ledger.NormalizeName(purchase.Item), ledger.NormalizeName(input.Query))
}

type findPurchasesResult struct {
	Purchases []purchaseResult `json:"purchases"`
	Truncated bool             `json:"truncated"`
}

func (svc *service) findPurchases(
	ctx context.Context, _ *sdk.CallToolRequest, input findPurchasesInput,
) (*sdk.CallToolResult, findPurchasesResult, error) {
	st, err := svc.load(ctx)
	if err != nil {
		return nil, findPurchasesResult{}, err
	}

	if input.PersonID != "" {
		_, err = st.person(input.PersonID)
		if err != nil {
			return nil, findPurchasesResult{}, err
		}
	}

	err = checkOptionalDate("since", input.Since)
	if err != nil {
		return nil, findPurchasesResult{}, err
	}

	err = checkOptionalDate("until", input.Until)
	if err != nil {
		return nil, findPurchasesResult{}, err
	}

	var matches []*ledger.Purchase

	for index := range st.snapshot.Purchases {
		if input.matches(&st.snapshot.Purchases[index]) {
			matches = append(matches, &st.snapshot.Purchases[index])
		}
	}

	slices.SortFunc(matches, func(left, right *ledger.Purchase) int {
		return cmp.Or(cmp.Compare(right.BoughtOn, left.BoughtOn), cmp.Compare(left.ID, right.ID))
	})

	result := findPurchasesResult{
		Purchases: make([]purchaseResult, 0, min(len(matches), findPurchasesLimit)),
		Truncated: len(matches) > findPurchasesLimit,
	}

	for _, purchase := range matches[:min(len(matches), findPurchasesLimit)] {
		result.Purchases = append(result.Purchases, st.newPurchaseResult(purchase, scheduleNone))
	}

	return nil, result, nil
}

type checkItem struct {
	Item     string `json:"item"     jsonschema:"The item name as shown on the order."`
	Price    string `json:"price"    jsonschema:"The full price as TRY text such as 1299,90 or 1.299,90."`
	BoughtOn string `json:"boughtOn" jsonschema:"The purchase date (YYYY-MM-DD)."`
}

type checkPurchasesInput struct {
	Items []checkItem `json:"items" jsonschema:"The purchases about to be recorded."`
}

type duplicateResult struct {
	PurchaseID string `json:"purchaseId"`
	PersonID   string `json:"personId"`
	PersonName string `json:"personName"`
	Item       string `json:"item"`
	BoughtOn   string `json:"boughtOn"`
	Plan       string `json:"plan"`
	Source     string `json:"source"`
	Total      string `json:"total"`
	TotalMinor int64  `json:"totalMinor"`
}

type checkedItemResult struct {
	Item               string            `json:"item"`
	BoughtOn           string            `json:"boughtOn"`
	Price              string            `json:"price"`
	PossibleDuplicates []duplicateResult `json:"possibleDuplicates"`
	PriceMinor         int64             `json:"priceMinor"`
}

type checkPurchasesResult struct {
	Results []checkedItemResult `json:"results"`
}

func (svc *service) checkPurchases(
	ctx context.Context, _ *sdk.CallToolRequest, input checkPurchasesInput,
) (*sdk.CallToolResult, checkPurchasesResult, error) {
	if len(input.Items) == 0 {
		return nil, checkPurchasesResult{}, fail("%s", checkPurchasesNoItem)
	}

	if len(input.Items) > maxCheckedItems {
		return nil, checkPurchasesResult{}, fail(
			"Check at most %d items at a time.",
			maxCheckedItems,
		)
	}

	st, err := svc.load(ctx)
	if err != nil {
		return nil, checkPurchasesResult{}, err
	}

	results := make([]checkedItemResult, 0, len(input.Items))

	for index, item := range input.Items {
		price, parseErr := parsePrice(item.Price)
		if parseErr != nil {
			return nil, checkPurchasesResult{}, fail("items[%d]: %v", index, parseErr)
		}

		if !ledger.ValidDate(item.BoughtOn) {
			return nil, checkPurchasesResult{}, fail(
				"items[%d]: boughtOn must be a date in YYYY-MM-DD form, got %q.",
				index,
				item.BoughtOn,
			)
		}

		results = append(results, checkedItemResult{
			Item: item.Item, BoughtOn: item.BoughtOn, Price: formatTRY(price),
			PossibleDuplicates: st.duplicatesOf(price, item.BoughtOn), PriceMinor: price,
		})
	}

	return nil, checkPurchasesResult{Results: results}, nil
}

func (st *state) duplicatesOf(price int64, boughtOn string) []duplicateResult {
	duplicates := []duplicateResult{}

	for index := range st.snapshot.Purchases {
		purchase := &st.snapshot.Purchases[index]
		if purchase.TotalMinor != price {
			continue
		}

		days, ok := ledger.DaysBetween(purchase.BoughtOn, boughtOn)
		if !ok || days < -duplicateWindowDays || days > duplicateWindowDays {
			continue
		}

		duplicates = append(duplicates, duplicateResult{
			PurchaseID: purchase.ID, PersonID: purchase.PersonID,
			PersonName: st.personName(purchase.PersonID), Item: purchase.Item,
			BoughtOn: purchase.BoughtOn, Plan: purchase.Plan, Source: purchase.Source,
			Total: formatTRY(purchase.TotalMinor), TotalMinor: purchase.TotalMinor,
		})
	}

	slices.SortFunc(duplicates, func(left, right duplicateResult) int {
		return cmp.Or(
			cmp.Compare(left.BoughtOn, right.BoughtOn),
			cmp.Compare(left.PurchaseID, right.PurchaseID),
		)
	})

	return duplicates
}
