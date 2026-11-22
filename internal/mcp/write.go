package mcp

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/zekihan/family-tab/internal/ledger"
)

const (
	defaultInstallments = 6
	lastDayDueDay       = 31
	undoWindow          = 24 * time.Hour

	keywordPayday     = "payday"
	keywordEndOfMonth = "endOfMonth"
	keywordInTwoWeeks = "inTwoWeeks"
)

func parsePrice(input string) (int64, error) {
	minor, err := ledger.ParseAmount(input)
	if err != nil {
		return 0, fail("%q is not a valid amount. Use TRY text such as 1299,90 or 1.299,90 "+
			"(a positive amount with at most two decimals, no currency symbol).", input)
	}

	return minor, nil
}

func checkOptionalDate(name, value string) error {
	if value != unsetDate && !ledger.ValidDate(value) {
		return fail("%s must be a date in YYYY-MM-DD form, got %q.", name, value)
	}

	return nil
}

func dateOrToday(name, value, today string) (string, error) {
	if value == unsetDate {
		return today, nil
	}

	err := checkOptionalDate(name, value)
	if err != nil {
		return "", err
	}

	return value, nil
}

func optionalNote(note string) *string {
	trimmed := strings.TrimSpace(note)
	if trimmed == "" {
		return nil
	}

	return &trimmed
}

type purchaseCreate struct {
	DueDate    *string `json:"dueDate"`
	Count      *int    `json:"count"`
	FirstDue   *string `json:"firstDue"`
	DueDay     *int    `json:"dueDay"`
	Note       *string `json:"note"`
	ID         string  `json:"id"`
	PersonID   string  `json:"personId"`
	Item       string  `json:"item"`
	BoughtOn   string  `json:"boughtOn"`
	Plan       string  `json:"plan"`
	TotalMinor int64   `json:"totalMinor"`
}

type addPurchaseInput struct {
	PersonID       string `json:"personId"                 jsonschema:"The person's id from list_people or find_person."`
	Item           string `json:"item"                     jsonschema:"What was bought, as the buyer calls it."`
	Price          string `json:"price"                    jsonschema:"Full price as TRY text, e.g. 1299,90 or 1.299,90."`
	BoughtOn       string `json:"boughtOn,omitempty"       jsonschema:"YYYY-MM-DD. Default today or an earlier due date."`
	Plan           string `json:"plan,omitempty"           jsonschema:"once (default) or installments."`
	DueDate        string `json:"dueDate,omitempty"        jsonschema:"Once only: date, payday, endOfMonth, inTwoWeeks."`
	Count          *int   `json:"count,omitempty"          jsonschema:"Installments only: 2 to 120. Default 6."`
	FirstDue       string `json:"firstDue,omitempty"       jsonschema:"Installments only: first due date (YYYY-MM-DD)."`
	Note           string `json:"note,omitempty"           jsonschema:"Optional note, at most 500 characters."`
	LastDayOfMonth bool   `json:"lastDayOfMonth,omitempty" jsonschema:"Installments only: due on each month's last day."`
}

type addPurchaseResult struct {
	Purchase purchaseResult `json:"purchase"`
	Person   personResult   `json:"person"`
	Balance  balanceResult  `json:"balance"`
}

func (svc *service) addPurchase(
	ctx context.Context, _ *sdk.CallToolRequest,
	input addPurchaseInput, //nolint:gocritic // The SDK passes tool inputs by value.
) (*sdk.CallToolResult, addPurchaseResult, error) {
	price, err := parsePrice(input.Price)
	if err != nil {
		return nil, addPurchaseResult{}, err
	}

	recordID := uuid.NewString()

	after, err := svc.write(ctx, func(st *state) (*change, error) {
		person, personErr := st.person(input.PersonID)
		if personErr != nil {
			return nil, personErr
		}

		record, buildErr := buildPurchase(st.today, person, &input, price)
		if buildErr != nil {
			return nil, buildErr
		}

		record.ID = recordID

		return createChange(ledger.TypePurchase, recordID, record), nil
	})
	if err != nil {
		return nil, addPurchaseResult{}, err
	}

	purchase, err := after.purchase(recordID)
	if err != nil {
		return nil, addPurchaseResult{}, err
	}

	person, err := after.person(purchase.PersonID)
	if err != nil {
		return nil, addPurchaseResult{}, err
	}

	return nil, addPurchaseResult{
		Purchase: after.newPurchaseResult(purchase, scheduleAll),
		Person:   newPersonResult(person),
		Balance:  newBalanceResult(after.view, person.ID),
	}, nil
}

func buildPurchase(
	today string, person *ledger.Person, input *addPurchaseInput, price int64,
) (*purchaseCreate, error) {
	item := ledger.TrimName(input.Item)
	if item == "" {
		return nil, fail("item must not be empty.")
	}

	boughtOn, err := dateOrToday("boughtOn", input.BoughtOn, today)
	if err != nil {
		return nil, err
	}

	record := &purchaseCreate{
		DueDate: nil, Count: nil, FirstDue: nil, DueDay: nil, Note: optionalNote(input.Note),
		ID: "", PersonID: person.ID, Item: item, BoughtOn: boughtOn, Plan: input.Plan,
		TotalMinor: price,
	}

	switch input.Plan {
	case "", ledger.PlanOnce:
		record.Plan = ledger.PlanOnce
		err = applyOnce(today, person, input, record)
	case ledger.PlanInstallments:
		err = applyInstallments(today, person, input, record)
	default:
		return nil, fail(
			"plan must be %q or %q, got %q.",
			ledger.PlanOnce,
			ledger.PlanInstallments,
			input.Plan,
		)
	}

	if err != nil {
		return nil, err
	}

	moveBoughtOnToDue(input, record)

	return record, nil
}

// moveBoughtOnToDue follows the Add purchase rule: a due date before a purchase
// date the buyer did not set moves the purchase date back to it.
func moveBoughtOnToDue(input *addPurchaseInput, record *purchaseCreate) {
	if input.BoughtOn != unsetDate {
		return
	}

	for _, due := range []*string{record.DueDate, record.FirstDue} {
		if due != nil && *due < record.BoughtOn {
			record.BoughtOn = *due
		}
	}
}

func applyOnce(
	today string, person *ledger.Person, input *addPurchaseInput, record *purchaseCreate,
) error {
	if input.Count != nil || input.FirstDue != unsetDate || input.LastDayOfMonth {
		return fail("count, firstDue and lastDayOfMonth only apply to plan installments.")
	}

	shortcuts := ledger.DueShortcuts(today, person.Payday)

	switch input.DueDate {
	case unsetDate:
	case keywordPayday:
		if shortcuts.Payday == nil {
			return fail(
				"%s has no payday, so dueDate cannot be payday. Use a date, endOfMonth or inTwoWeeks.",
				person.Name,
			)
		}

		record.DueDate = shortcuts.Payday
	case keywordEndOfMonth:
		record.DueDate = &shortcuts.EndOfMonth
	case keywordInTwoWeeks:
		record.DueDate = &shortcuts.InTwoWeeks
	default:
		if !ledger.ValidDate(input.DueDate) {
			return fail(
				"dueDate must be a date in YYYY-MM-DD form or payday, endOfMonth or inTwoWeeks, got %q.",
				input.DueDate,
			)
		}

		record.DueDate = &input.DueDate
	}

	return nil
}

func applyInstallments(
	today string, person *ledger.Person, input *addPurchaseInput, record *purchaseCreate,
) error {
	if input.DueDate != unsetDate {
		return fail("dueDate only applies to plan once. Use firstDue and count for installments.")
	}

	count := defaultInstallments
	if input.Count != nil {
		count = *input.Count
	}

	record.Count = &count

	if input.FirstDue == unsetDate {
		if input.LastDayOfMonth {
			return fail(
				"lastDayOfMonth needs an explicit firstDue that is the last day of a month.",
			)
		}

		start := ledger.DefaultInstallmentStart(today, person.Payday)
		record.FirstDue, record.DueDay = &start.FirstDue, &start.DueDay

		return nil
	}

	day, ok := ledger.DayOfMonth(input.FirstDue)
	if !ok {
		return fail("firstDue must be a date in YYYY-MM-DD form, got %q.", input.FirstDue)
	}

	if input.LastDayOfMonth && ledger.IsLastDayOfMonth(input.FirstDue) {
		day = lastDayDueDay
	}

	record.FirstDue, record.DueDay = &input.FirstDue, &day

	return nil
}

type paymentCreate struct {
	Note        *string `json:"note"`
	ID          string  `json:"id"`
	PersonID    string  `json:"personId"`
	PaidOn      string  `json:"paidOn"`
	AmountMinor int64   `json:"amountMinor"`
}

type recordPaymentInput struct {
	PersonID string `json:"personId"         jsonschema:"The person's id from list_people or find_person."`
	Amount   string `json:"amount"           jsonschema:"The amount received as TRY text, e.g. 5000 or 1.250,50."`
	PaidOn   string `json:"paidOn,omitempty" jsonschema:"Date received (YYYY-MM-DD). Default today."`
	Note     string `json:"note,omitempty"   jsonschema:"Optional note, at most 500 characters."`
}

type recordPaymentResult struct {
	Payment paymentResult `json:"payment"`
	Balance balanceResult `json:"balance"`
}

func (svc *service) recordPayment(
	ctx context.Context, _ *sdk.CallToolRequest, input recordPaymentInput,
) (*sdk.CallToolResult, recordPaymentResult, error) {
	amount, err := parsePrice(input.Amount)
	if err != nil {
		return nil, recordPaymentResult{}, err
	}

	recordID := uuid.NewString()

	after, err := svc.write(ctx, func(st *state) (*change, error) {
		person, personErr := st.person(input.PersonID)
		if personErr != nil {
			return nil, personErr
		}

		paidOn, dateErr := dateOrToday("paidOn", input.PaidOn, st.today)
		if dateErr != nil {
			return nil, dateErr
		}

		return createChange(ledger.TypePayment, recordID, &paymentCreate{
			Note: optionalNote(input.Note), ID: recordID, PersonID: person.ID,
			PaidOn: paidOn, AmountMinor: amount,
		}), nil
	})
	if err != nil {
		return nil, recordPaymentResult{}, err
	}

	index := slices.IndexFunc(after.snapshot.Payments, func(payment ledger.Payment) bool {
		return payment.ID == recordID
	})
	if index < 0 {
		return nil, recordPaymentResult{}, fail(
			"The payment was recorded but could not be read back.",
		)
	}

	payment := after.snapshot.Payments[index]

	return nil, recordPaymentResult{
		Payment: paymentResult{
			Note: payment.Note, ID: payment.ID, PersonID: payment.PersonID,
			PersonName: after.personName(payment.PersonID), Amount: formatTRY(payment.AmountMinor),
			PaidOn: payment.PaidOn, Source: payment.Source, AmountMinor: payment.AmountMinor,
		},
		Balance: newBalanceResult(after.view, payment.PersonID),
	}, nil
}

type refundCreate struct {
	Note        *string `json:"note"`
	ID          string  `json:"id"`
	PurchaseID  string  `json:"purchaseId"`
	RefundedOn  string  `json:"refundedOn"`
	AmountMinor int64   `json:"amountMinor"`
}

type addRefundInput struct {
	PurchaseID string `json:"purchaseId"           jsonschema:"The purchase's id from get_statement or find_purchases."`
	Amount     string `json:"amount"               jsonschema:"The amount the shop refunded as TRY text, e.g. 99,90."`
	RefundedOn string `json:"refundedOn,omitempty" jsonschema:"Date of the refund (YYYY-MM-DD). Default today."`
	Note       string `json:"note,omitempty"       jsonschema:"Optional note, at most 500 characters."`
}

type addRefundResult struct {
	Refund   refundResult   `json:"refund"`
	Purchase purchaseResult `json:"purchase"`
	Balance  balanceResult  `json:"balance"`
}

func (svc *service) addRefund(
	ctx context.Context, _ *sdk.CallToolRequest, input addRefundInput,
) (*sdk.CallToolResult, addRefundResult, error) {
	amount, err := parsePrice(input.Amount)
	if err != nil {
		return nil, addRefundResult{}, err
	}

	recordID := uuid.NewString()

	after, err := svc.write(ctx, func(st *state) (*change, error) {
		purchase, purchaseErr := st.purchase(input.PurchaseID)
		if purchaseErr != nil {
			return nil, purchaseErr
		}

		refundedOn, dateErr := dateOrToday("refundedOn", input.RefundedOn, st.today)
		if dateErr != nil {
			return nil, dateErr
		}

		return createChange(ledger.TypeRefund, recordID, &refundCreate{
			Note: optionalNote(input.Note), ID: recordID, PurchaseID: purchase.ID,
			RefundedOn: refundedOn, AmountMinor: amount,
		}), nil
	})
	if err != nil {
		return nil, addRefundResult{}, err
	}

	index := slices.IndexFunc(after.snapshot.Refunds, func(refund ledger.Refund) bool {
		return refund.ID == recordID
	})
	if index < 0 {
		return nil, addRefundResult{}, fail("The refund was recorded but could not be read back.")
	}

	refund := after.snapshot.Refunds[index]

	purchase, err := after.purchase(refund.PurchaseID)
	if err != nil {
		return nil, addRefundResult{}, err
	}

	return nil, addRefundResult{
		Refund: refundResult{
			Note: refund.Note, ID: refund.ID, PurchaseID: refund.PurchaseID, Item: purchase.Item,
			Amount: formatTRY(refund.AmountMinor), RefundedOn: refund.RefundedOn,
			Source: refund.Source, AmountMinor: refund.AmountMinor,
		},
		Purchase: after.newPurchaseResult(purchase, scheduleUnpaid),
		Balance:  newBalanceResult(after.view, purchase.PersonID),
	}, nil
}

type aliasInput struct {
	PersonID string `json:"personId" jsonschema:"The person's id from list_people or find_person."`
	Alias    string `json:"alias"    jsonschema:"The wording to save, for example Annem. At most 40 characters."`
}

type aliasResult struct {
	Person personResult `json:"person"`
}

func (svc *service) addAlias(
	ctx context.Context, _ *sdk.CallToolRequest, input aliasInput,
) (*sdk.CallToolResult, aliasResult, error) {
	alias := ledger.TrimName(input.Alias)
	if alias == "" {
		return nil, aliasResult{}, fail("alias must not be empty.")
	}

	return svc.editAliases(ctx, input.PersonID, func(person *ledger.Person) ([]string, error) {
		return append(slices.Clone(person.Aliases), alias), nil
	})
}

func (svc *service) removeAlias(
	ctx context.Context, _ *sdk.CallToolRequest, input aliasInput,
) (*sdk.CallToolResult, aliasResult, error) {
	key := ledger.NormalizeName(input.Alias)

	return svc.editAliases(ctx, input.PersonID, func(person *ledger.Person) ([]string, error) {
		aliases := slices.Clone(person.Aliases)

		index := slices.IndexFunc(aliases, func(alias string) bool {
			return key != "" && ledger.NormalizeName(alias) == key
		})
		if index < 0 {
			return nil, fail("%s has no alias matching %q. Current aliases: %s.",
				person.Name, input.Alias, strings.Join(aliases, ", "))
		}

		return slices.Delete(aliases, index, index+1), nil
	})
}

func (svc *service) editAliases(
	ctx context.Context,
	personID string,
	edit func(*ledger.Person) ([]string, error),
) (*sdk.CallToolResult, aliasResult, error) {
	after, err := svc.write(ctx, func(st *state) (*change, error) {
		person, personErr := st.person(personID)
		if personErr != nil {
			return nil, personErr
		}

		aliases, editErr := edit(person)
		if editErr != nil {
			return nil, editErr
		}

		return updateChange(
			ledger.TypePerson, person.ID, person.Version, map[string][]string{"aliases": aliases},
		), nil
	})
	if err != nil {
		return nil, aliasResult{}, err
	}

	person, err := after.person(personID)
	if err != nil {
		return nil, aliasResult{}, err
	}

	return nil, aliasResult{Person: newPersonResult(person)}, nil
}

type undoInput struct {
	RecordID string `json:"recordId" jsonschema:"The id of the purchase, payment or refund to delete."`
}

type undoResult struct {
	RecordType string `json:"recordType"`
	RecordID   string `json:"recordId"`
	Message    string `json:"message"`
	Deleted    bool   `json:"deleted"`
}

// undoTarget is a record Undo may delete.
type undoTarget struct {
	record     any
	recordType string
	version    string
	source     string
	summary    string
}

func (st *state) undoTarget(recordID string) (*undoTarget, error) {
	for index := range st.snapshot.Purchases {
		purchase := &st.snapshot.Purchases[index]
		if purchase.ID == recordID {
			return &undoTarget{
				record: purchase, recordType: ledger.TypePurchase, version: purchase.Version,
				source:  purchase.Source,
				summary: "purchase \"" + purchase.Item + "\" of " + formatTRY(purchase.TotalMinor),
			}, nil
		}
	}

	for index := range st.snapshot.Payments {
		payment := &st.snapshot.Payments[index]
		if payment.ID == recordID {
			return &undoTarget{
				record:     payment,
				recordType: ledger.TypePayment,
				version:    payment.Version,
				source:     payment.Source,
				summary: "payment of " + formatTRY(
					payment.AmountMinor,
				) + " from " + st.personName(
					payment.PersonID,
				),
			}, nil
		}
	}

	for index := range st.snapshot.Refunds {
		refund := &st.snapshot.Refunds[index]
		if refund.ID == recordID {
			return &undoTarget{
				record: refund, recordType: ledger.TypeRefund, version: refund.Version,
				source:  refund.Source,
				summary: "refund of " + formatTRY(refund.AmountMinor),
			}, nil
		}
	}

	return nil, fail(
		"No purchase, payment or refund has the id %q. Undo only deletes those three.",
		recordID,
	)
}

func (svc *service) undo(
	ctx context.Context, _ *sdk.CallToolRequest, input undoInput,
) (*sdk.CallToolResult, undoResult, error) {
	var summary, recordType string

	_, err := svc.write(ctx, func(st *state) (*change, error) {
		target, targetErr := st.undoTarget(input.RecordID)
		if targetErr != nil {
			return nil, targetErr
		}

		allowErr := svc.checkUndo(ctx, target, input.RecordID)
		if allowErr != nil {
			return nil, allowErr
		}

		summary, recordType = target.summary, target.recordType

		return deleteChange(target.recordType, input.RecordID, target.version, target.record), nil
	})
	if err != nil {
		return nil, undoResult{}, err
	}

	return nil, undoResult{
		RecordType: recordType, RecordID: input.RecordID, Deleted: true,
		Message: "Deleted the " + summary + ".",
	}, nil
}

func (svc *service) checkUndo(ctx context.Context, target *undoTarget, recordID string) error {
	if target.source != ledger.SourceAgent {
		return fail(
			"This %s was not created through the agent connector, so it cannot be undone here. "+
				"The buyer can delete or edit it in the app.",
			target.recordType,
		)
	}

	createdAt, found, err := svc.ledger.CreatedAt(ctx, target.version, target.recordType, recordID)
	if err != nil {
		slog.ErrorContext(ctx, "Could not check an MCP undo history", slog.Any("error", err))

		return fail("The record's history could not be checked. " +
			"The buyer can correct it in the app.")
	}

	if !found {
		return fail("This %s was changed after it was created, so it cannot be undone here. "+
			"The buyer can correct it in the app.", target.recordType)
	}

	if svc.now().Sub(createdAt) >= undoWindow {
		return fail("This %s was created more than 24 hours ago, so it cannot be undone here. "+
			"The buyer can correct it in the app.", target.recordType)
	}

	return nil
}
