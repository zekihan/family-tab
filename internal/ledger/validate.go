package ledger

import (
	"iter"
	"maps"
	"strings"
	"time"
	"unicode/utf8"
)

type recordKey struct {
	kind, id string
}

func recordEntries(records *Records) iter.Seq2[recordKey, any] {
	return func(yield func(recordKey, any) bool) {
		if records.Settings != nil &&
			!yield(recordKey{TypeSettings, records.Settings.ID}, records.Settings) {
			return
		}

		for i := range records.People {
			person := &records.People[i]
			if !yield(recordKey{TypePerson, person.ID}, person) {
				return
			}
		}

		for i := range records.Purchases {
			purchase := &records.Purchases[i]
			if !yield(recordKey{TypePurchase, purchase.ID}, purchase) {
				return
			}
		}

		for i := range records.Payments {
			payment := &records.Payments[i]
			if !yield(recordKey{TypePayment, payment.ID}, payment) {
				return
			}
		}

		for i := range records.Refunds {
			refund := &records.Refunds[i]
			if !yield(recordKey{TypeRefund, refund.ID}, refund) {
				return
			}
		}

		for i := range records.Payouts {
			payout := &records.Payouts[i]
			if !yield(recordKey{TypePayout, payout.ID}, payout) {
				return
			}
		}
	}
}

type recordRules struct {
	rows    map[recordKey]any
	refunds map[string][]Refund
	today   string
}

func indexRecordRules(records *Records, today string) recordRules {
	rules := recordRules{
		today: today, rows: make(map[recordKey]any), refunds: refundsByPurchase(records.Refunds),
	}
	maps.Insert(rules.rows, recordEntries(records))

	return rules
}

func rule(code, reason string, blocking ...string) *RuleError {
	if blocking == nil {
		blocking = []string{}
	}

	return &RuleError{Code: code, Reason: reason, Blocking: blocking}
}

func validateRecords(records *Records, today string) *RuleError {
	if records == nil || records.Settings == nil {
		return rule(CodeInvalid, "missing ledger settings")
	}

	if _, ok := parseDate(today); !ok {
		return rule(CodeInvalid, "invalid today date")
	}

	rules := indexRecordRules(records, today)

	ids := make(map[string]struct{}, len(rules.rows))
	for key, row := range recordEntries(records) {
		if _, duplicate := ids[key.id]; duplicate {
			return rule(CodeDuplicateID, "record ID is already in use")
		}

		ids[key.id] = struct{}{}

		err := rules.validate(row, nil)
		if err != nil {
			return err
		}
	}

	for i := range records.Purchases {
		err := rules.validateRefundSum(&records.Purchases[i])
		if err != nil {
			return err
		}
	}

	return nil
}

func (rules recordRules) validate(row, previous any) *RuleError {
	switch value := row.(type) {
	case *Settings:
		return validateSettings(value)
	case *Person:
		return validatePerson(value)
	case *Purchase:
		old := asRecord[*Purchase](previous)

		return rules.validatePurchase(value, old)
	case *Payment:
		old := asRecord[*Payment](previous)

		return rules.validateCash(value.PersonID, value.AmountMinor, value.Note,
			value.PaidOn, old == nil || old.PaidOn != value.PaidOn)
	case *Refund:
		old := asRecord[*Refund](previous)

		return rules.validateRefund(value, old == nil || old.RefundedOn != value.RefundedOn)
	case *Payout:
		old := asRecord[*Payout](previous)

		return rules.validateCash(value.PersonID, value.AmountMinor, value.Note,
			value.PaidOutOn, old == nil || old.PaidOutOn != value.PaidOutOn)
	default:
		return rule(CodeInvalid, "missing changed record")
	}
}

func validateSettings(settings *Settings) *RuleError {
	if settings.ID != SettingsID || settings.Currency != CurrencyTRY {
		return rule(CodeInvalid, "invalid ledger ID or currency")
	}

	if settings.TimeZone == "" || settings.TimeZone == "Local" {
		return rule(CodeInvalid, "invalid ledger time zone")
	}

	_, err := time.LoadLocation(settings.TimeZone)
	if err != nil {
		return rule(CodeInvalid, "invalid ledger time zone")
	}

	return nil
}

func validatePerson(person *Person) *RuleError {
	if !validLabel(person.Name) {
		return rule(CodeInvalid, "name must contain 1 to 200 characters")
	}

	if person.Payday != nil && (*person.Payday < 1 || *person.Payday > 31) {
		return rule(CodeInvalid, "payday must be between 1 and 31")
	}

	return nil
}

func validLabel(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.RuneCountInString(value) <= 200
}

func validNote(note *string) bool {
	return note == nil || utf8.RuneCountInString(*note) <= 500
}

func (rules recordRules) validateDate(date string, checkFuture bool) *RuleError {
	if _, ok := parseDate(date); !ok {
		return rule(CodeInvalid, "invalid calendar date")
	}

	if checkFuture && date > rules.today {
		return rule(CodeInvalid, "record date is in the future")
	}

	return nil
}

func asRecord[T any](row any) T {
	if record, ok := row.(T); ok {
		return record
	}

	var zero T

	return zero
}

func (rules recordRules) person(id string) *Person {
	return asRecord[*Person](rules.rows[recordKey{TypePerson, id}])
}

func (rules recordRules) purchase(id string) *Purchase {
	return asRecord[*Purchase](rules.rows[recordKey{TypePurchase, id}])
}

func (rules recordRules) validatePurchase(purchase, previous *Purchase) *RuleError {
	if rules.person(purchase.PersonID) == nil {
		return rule(CodeNotFound, "person not found")
	}

	if !validLabel(purchase.Item) {
		return rule(CodeInvalid, "item must contain 1 to 200 characters")
	}

	if !validNote(purchase.Note) {
		return rule(CodeInvalid, "note exceeds 500 characters")
	}

	err := rules.validateDate(
		purchase.BoughtOn, previous == nil || previous.BoughtOn != purchase.BoughtOn,
	)
	if err != nil {
		return err
	}

	_, scheduleErr := scheduleStart(purchase)
	if scheduleErr != nil {
		return rule(CodeInvalid, scheduleErr.Error())
	}

	if dateBefore(purchase.DueDate, purchase.BoughtOn) ||
		dateBefore(purchase.FirstDue, purchase.BoughtOn) {
		return rule(CodeInvalid, "due date precedes purchase")
	}

	return nil
}

func dateBefore(date *string, other string) bool {
	return date != nil && *date < other
}

func (rules recordRules) validateCash(
	personID string, amount int64, note *string, date string, checkFuture bool,
) *RuleError {
	if rules.person(personID) == nil {
		return rule(CodeNotFound, "person not found")
	}

	return rules.validateMoney(amount, note, date, checkFuture)
}

func (rules recordRules) validateMoney(
	amount int64, note *string, date string, checkFuture bool,
) *RuleError {
	if !validAmount(amount) {
		return rule(CodeInvalid, "amount is outside the allowed range")
	}

	if !validNote(note) {
		return rule(CodeInvalid, "note exceeds 500 characters")
	}

	return rules.validateDate(date, checkFuture)
}

func (rules recordRules) validateRefund(refund *Refund, checkFuture bool) *RuleError {
	purchase := rules.purchase(refund.PurchaseID)
	if purchase == nil {
		return rule(CodeNotFound, "purchase not found")
	}

	err := rules.validateMoney(
		refund.AmountMinor, refund.Note, refund.RefundedOn, checkFuture,
	)
	if err != nil {
		return err
	}

	if refund.RefundedOn < purchase.BoughtOn {
		return rule(CodeInvalid, "refund date precedes purchase")
	}

	return nil
}

func (rules recordRules) validateRefundSum(purchase *Purchase) *RuleError {
	remaining := max(0, purchase.TotalMinor)
	for _, refund := range rules.refunds[purchase.ID] {
		amount := max(0, refund.AmountMinor)
		if amount > remaining {
			return rule(CodeRefundsExceedTotal, errRefundTotal.Error())
		}

		remaining -= amount
	}

	return nil
}
