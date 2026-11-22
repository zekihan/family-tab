// Command ledgercalc runs the Go side of the cross-language ledger test.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
)

type calcCase struct {
	Today    string         `json:"today"`
	TimeZone string         `json:"timeZone"`
	Records  ledger.Records `json:"records"`
	Changes  []caseChange   `json:"changes"`
	Amounts  []string       `json:"amounts"`
}

type caseChange struct {
	Op protocol.Operation `json:"op"`
}

type schedules struct {
	Base     []ledger.ScheduledAmount `json:"base"`
	Adjusted []ledger.ScheduledAmount `json:"adjusted"`
}

type result struct {
	Schedules map[string]schedules            `json:"schedules"`
	People    map[string]ledger.PersonBalance `json:"people"`
	Valid     *string                         `json:"valid"`
	Changes   []changeResult                  `json:"changes"`
	Amounts   []*int64                        `json:"amounts"`
}

type changeResult struct {
	Code        *string `json:"code"`
	RecordsCode *string `json:"recordsCode"`
}

func main() {
	err := run(os.Stdin, os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(input io.Reader, output io.Writer) error {
	var batch struct {
		Cases []calcCase `json:"cases"`
	}

	err := json.NewDecoder(input).Decode(&batch)
	if err != nil {
		return fmt.Errorf("decode cases: %w", err)
	}

	results := make([]result, len(batch.Cases))
	for i := range batch.Cases {
		results[i], err = calculate(&batch.Cases[i])
		if err != nil {
			return fmt.Errorf("case %d: %w", i, err)
		}
	}

	err = json.NewEncoder(output).Encode(results)
	if err != nil {
		return fmt.Errorf("encode results: %w", err)
	}

	return nil
}

func calculate(input *calcCase) (result, error) {
	records := input.Records
	records.Settings = &ledger.Settings{
		ID:       ledger.SettingsID,
		Currency: ledger.CurrencyTRY,
		TimeZone: input.TimeZone,
		Version:  "fixture",
	}
	got := result{
		Schedules: make(map[string]schedules, len(records.Purchases)),
		People:    ledger.Balances(&records),
		Valid:     code(ledger.ValidateRecords(&records, input.Today)),
		Changes:   make([]changeResult, len(input.Changes)),
		Amounts:   make([]*int64, len(input.Amounts)),
	}

	for i := range records.Purchases {
		purchase := &records.Purchases[i]
		// The schedule APIs return nil on error, encoded as JSON null.
		got.Schedules[purchase.ID] = schedules{
			Base:     scheduleOrNull(ledger.BuildSchedule(purchase)),
			Adjusted: scheduleOrNull(ledger.AdjustedSchedule(purchase, records.Refunds)),
		}
	}

	for i := range input.Changes {
		op := &input.Changes[i].Op

		after, err := applyOperation(&records, op)
		if err != nil {
			return result{}, fmt.Errorf("change %d (%s): %w", i, op.ID, err)
		}

		change := ledger.Change{
			Kind: op.Kind, RecordType: op.RecordType, RecordID: op.RecordID,
			AlreadyReturned: op.AlreadyReturned,
		}
		got.Changes[i] = changeResult{
			Code:        code(ledger.ValidateChange(&records, &after, change, input.Today)),
			RecordsCode: code(ledger.ValidateRecords(&after, input.Today)),
		}
	}

	for i, input := range input.Amounts {
		minor, err := ledger.ParseAmount(input)
		if err == nil {
			got.Amounts[i] = &minor
		}
	}

	return got, nil
}

func scheduleOrNull(schedule []ledger.ScheduledAmount, err error) []ledger.ScheduledAmount {
	if err != nil {
		return nil
	}

	return schedule
}

func code(err *ledger.RuleError) *string {
	if err == nil {
		return nil
	}

	return &err.Code
}
