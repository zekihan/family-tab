package ledger

import (
	"fmt"
	"time"
)

// ParseAmount parses a user-entered TRY amount into kuruş under the rules in
// DESIGN.md section 8, Parsing amounts.
func ParseAmount(input string) (int64, error) {
	return parseAmount(input)
}

// BuildSchedule returns the base schedule of a purchase, with AdjustedMinor
// equal to BaseMinor.
func BuildSchedule(purchase *Purchase) ([]ScheduledAmount, error) {
	return buildSchedule(purchase)
}

// AdjustedSchedule returns the schedule after applying the purchase's shop
// refunds, last installment first.
func AdjustedSchedule(purchase *Purchase, refunds []Refund) ([]ScheduledAmount, error) {
	return adjustedSchedule(purchase, refunds)
}

// Balances computes the payout-relevant figures for every person.
func Balances(records *Records) map[string]PersonBalance {
	return balances(records)
}

// ValidateRecords checks the record rules over a whole ledger, as done for
// every record in a restore. Today is the date in the ledger time zone.
func ValidateRecords(records *Records, today string) *RuleError {
	return validateRecords(records, today)
}

// ValidateChange checks the record rules on the records the change touches
// and the change rules, comparing before and after. Today is the date in the
// ledger time zone.
func ValidateChange(before, after *Records, change Change, today string) *RuleError {
	return validateChange(before, after, change, today)
}

// Today returns the calendar date in the IANA zone at the given Unix time.
func Today(timeZone string, unixSeconds int64) (string, error) {
	loc, err := time.LoadLocation(timeZone)
	if err != nil {
		return "", fmt.Errorf("load time zone %q: %w", timeZone, err)
	}

	return time.Unix(unixSeconds, 0).In(loc).Format(time.DateOnly), nil
}
