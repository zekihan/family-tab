package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
)

var errRecordType = errors.New("unknown record type")

func applyOperation(before *ledger.Records, op *protocol.Operation) (ledger.Records, error) {
	after := *before

	var err error

	switch op.RecordType {
	case ledger.TypePerson:
		after.People, err = applyRows(
			before.People,
			op,
			func(row ledger.Person) string { return row.ID },
		)
	case ledger.TypePurchase:
		after.Purchases, err = applyRows(before.Purchases, op, func(row ledger.Purchase) string {
			return row.ID
		})
	case ledger.TypePayment:
		after.Payments, err = applyRows(before.Payments, op, func(row ledger.Payment) string {
			return row.ID
		})
	case ledger.TypeRefund:
		after.Refunds, err = applyRows(
			before.Refunds,
			op,
			func(row ledger.Refund) string { return row.ID },
		)
	case ledger.TypePayout:
		after.Payouts, err = applyRows(
			before.Payouts,
			op,
			func(row ledger.Payout) string { return row.ID },
		)
	case ledger.TypeSettings:
		after.Settings, err = applySettings(before.Settings, op)
	default:
		return ledger.Records{}, fmt.Errorf("%w %q", errRecordType, op.RecordType)
	}

	return after, err
}

func applySettings(before *ledger.Settings, op *protocol.Operation) (*ledger.Settings, error) {
	var rows []ledger.Settings
	if before != nil {
		rows = append(rows, *before)
	}

	rows, err := applyRows(rows, op, func(row ledger.Settings) string { return row.ID })
	if err != nil || len(rows) == 0 {
		return nil, err
	}

	return &rows[len(rows)-1], nil
}

func applyRows[T any](before []T, op *protocol.Operation, id func(T) string) ([]T, error) {
	after := make([]T, 0, len(before)+1)

	for _, row := range before {
		if id(row) == op.RecordID {
			switch op.Kind {
			case ledger.KindDelete:
				continue
			case ledger.KindUpdate:
				updated, err := patchRow(row, op.Patch)
				if err != nil {
					return nil, err
				}

				row = updated
			}
		}

		after = append(after, row)
	}

	if op.Kind == ledger.KindCreate {
		var row T

		err := json.Unmarshal(op.Record, &row)
		if err != nil {
			return nil, fmt.Errorf("decode new record: %w", err)
		}

		after = append(after, row)
	}

	return after, nil
}

func patchRow[T any](row T, patch json.RawMessage) (T, error) {
	var updated T

	// Decode into a fresh row so changes to pointer fields cannot mutate before.
	original, err := json.Marshal(row)
	if err != nil {
		return updated, fmt.Errorf("encode original record: %w", err)
	}

	err = json.Unmarshal(original, &updated)
	if err != nil {
		return updated, fmt.Errorf("decode original record: %w", err)
	}

	err = json.Unmarshal(patch, &updated)
	if err != nil {
		return updated, fmt.Errorf("decode patch: %w", err)
	}

	return updated, nil
}
