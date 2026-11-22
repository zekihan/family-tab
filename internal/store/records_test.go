package store

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/zekihan/family-tab/internal/ledger"
)

func TestReplaceRecordsRollsBackOnMissingPerson(t *testing.T) {
	t.Parallel()

	st, err := Open(t.Context(), filepath.Join(t.TempDir(), "ledger.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	original := &ledger.Records{
		Settings: &ledger.Settings{
			ID:       ledger.SettingsID,
			TimeZone: "UTC",
			Currency: ledger.CurrencyTRY,
			Version:  "setup",
		},
		Purchases: nil,
		Refunds:   nil,
		People: []ledger.Person{
			{
				Payday:   nil,
				Archived: false,
				ID:       "mom",
				Name:     "Mom",
				Version:  "added",
				Aliases:  []string{},
			},
		},
		Payments: []ledger.Payment{
			{
				Note:        nil,
				ID:          "p",
				PersonID:    "mom",
				AmountMinor: 500,
				PaidOn:      "2025-08-02",
				Source:      ledger.SourceApp,
				Version:     "paid",
			},
		},
		Payouts: []ledger.Payout{
			{
				Note:        nil,
				ID:          "cash",
				PersonID:    "mom",
				AmountMinor: 200,
				PaidOutOn:   "2025-08-03",
				Version:     "returned",
			},
		},
	}

	replace := func(records *ledger.Records) error {
		return st.Write(t.Context(), func(ctx context.Context, tx *Tx) error {
			return tx.ReplaceRecords(ctx, records)
		})
	}

	err = replace(original)
	if err != nil {
		t.Fatal(err)
	}

	before := readRecords(t, st)
	if !reflect.DeepEqual(before.Payments, original.Payments) ||
		!reflect.DeepEqual(before.Payouts, original.Payouts) {
		t.Fatalf("records did not round trip: %+v", before)
	}

	broken := *original
	broken.People = []ledger.Person{
		{
			Payday:   nil,
			Archived: false,
			ID:       "dad",
			Name:     "Dad",
			Version:  "added",
			Aliases:  []string{},
		},
	}

	err = replace(&broken)
	if err == nil {
		t.Fatal("replacement accepted payments for a missing person")
	}

	if after := readRecords(t, st); !reflect.DeepEqual(after, before) {
		t.Fatalf("failed replacement changed records: %+v", after)
	}
}
