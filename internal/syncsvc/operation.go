package syncsvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

var errTimeZone = errors.New("timeZone must name an IANA time zone")

func commitOperation(
	ctx context.Context,
	tx *store.Tx,
	op *protocol.Operation,
	meta store.Meta,
	now time.Time,
	source string,
) (protocol.Receipt, error) {
	receipt := protocol.Receipt{
		Code: nil, Reason: nil, Status: "",
		OpID: op.ID, Generation: meta.Generation, Revision: meta.Revision,
		Current: json.RawMessage("null"), Blocking: []string{},
	}

	before, err := tx.Records(ctx)
	if err != nil {
		return receipt, fmt.Errorf("prepare operation %q: %w", op.ID, err)
	}

	after := *before

	record, current, rule := prepareChange(before, &after, op, source)
	if rule == nil {
		rule = validateChange(before, &after, op, now)
	}

	if rule == nil {
		err = writeOperation(ctx, tx, op, record, &meta)
		if err != nil {
			return receipt, err
		}

		receipt.Status = protocol.StatusApplied
		receipt.Revision = meta.Revision
	} else {
		receipt.Status = protocol.StatusRejected
		receipt.Code = &rule.Code
		receipt.Reason = &rule.Reason
		receipt.Blocking = append(receipt.Blocking, rule.Blocking...)

		if rule.Code == ledger.CodeConflict {
			receipt.Status = protocol.StatusConflict
			receipt.Current = current
		}
	}

	err = saveReceipt(ctx, tx, &store.Receipt{
		Body: nil, CreatedAt: now, OpID: op.ID, Status: receipt.Status, Meta: meta,
		Kind: op.Kind, RecordType: op.RecordType, RecordID: op.RecordID,
	}, receipt)

	return receipt, err
}

func validateChange(
	before, after *ledger.Records,
	op *protocol.Operation,
	now time.Time,
) *ledger.RuleError {
	zone := "UTC"

	switch {
	case before.Settings != nil:
		zone = before.Settings.TimeZone
	case after.Settings != nil:
		zone = after.Settings.TimeZone
	}

	today, err := todayInZone(zone, now)
	if err != nil {
		return invalid(err.Error())
	}

	return ledger.ValidateChange(before, after, ledger.Change{
		Kind: op.Kind, RecordType: op.RecordType, RecordID: op.RecordID,
		AlreadyReturned: op.AlreadyReturned,
	}, today)
}

func writeOperation(
	ctx context.Context,
	tx *store.Tx,
	op *protocol.Operation,
	record any,
	meta *store.Meta,
) error {
	var err error
	if op.Kind == ledger.KindDelete {
		err = tx.DeleteRecord(ctx, op.RecordType, op.RecordID)
	} else {
		err = tx.SaveRecord(ctx, record)
	}

	if err != nil {
		return fmt.Errorf("write operation %q: %w", op.ID, err)
	}

	meta.Revision++

	err = tx.SaveMeta(ctx, *meta)
	if err != nil {
		return fmt.Errorf("advance revision for %q: %w", op.ID, err)
	}

	return nil
}

func todayInZone(zone string, now time.Time) (string, error) {
	if zone == "" || zone == "Local" {
		return "", errTimeZone
	}

	today, err := ledger.Today(zone, now.Unix())
	if err != nil {
		return "", fmt.Errorf("calculate ledger date: %w", err)
	}

	return today, nil
}

func isUUIDv4(value string) bool {
	id, err := uuid.Parse(value)

	return err == nil && id.Version() == 4 && id.Variant() == uuid.RFC4122 && id.String() == value
}

func invalid(reason string) *ledger.RuleError {
	return &ledger.RuleError{Code: ledger.CodeInvalid, Reason: reason, Blocking: nil}
}

func prepareChange(
	before, after *ledger.Records,
	op *protocol.Operation,
	source string,
) (any, json.RawMessage, *ledger.RuleError) {
	rule := validateOperation(op)
	if rule != nil {
		return nil, nil, rule
	}

	if before.Settings == nil &&
		(op.RecordType != ledger.TypeSettings || op.Kind != ledger.KindCreate) {
		return nil, nil, &ledger.RuleError{
			Blocking: nil,
			Code:     ledger.CodeNotSetup,
			Reason:   "Set up the ledger before making changes.",
		}
	}

	if op.Kind == ledger.KindCreate && containsID(before, op.RecordID) {
		return nil, nil, &ledger.RuleError{
			Blocking: nil, Code: ledger.CodeDuplicateID, Reason: "The record ID already exists.",
		}
	}

	return editRecord(before, after, op, source)
}

func validateOperation(op *protocol.Operation) *ledger.RuleError {
	if !isUUIDv4(op.ID) {
		return invalid("The operation ID must be a lowercase UUIDv4.")
	}

	if op.RecordType == ledger.TypeSettings {
		if op.RecordID != ledger.SettingsID {
			return invalid("The settings record ID must be ledger.")
		}
	} else if !isUUIDv4(op.RecordID) {
		return invalid("The record ID must be a lowercase UUIDv4.")
	}

	if op.AlreadyReturned && op.RecordType != ledger.TypePayout {
		return invalid("alreadyReturned is only valid for payouts.")
	}

	return nil
}

func containsID(records *ledger.Records, id string) bool {
	return (records.Settings != nil && records.Settings.ID == id) ||
		slices.ContainsFunc(records.People, func(row ledger.Person) bool { return row.ID == id }) ||
		slices.ContainsFunc(
			records.Purchases,
			func(row ledger.Purchase) bool { return row.ID == id },
		) ||
		slices.ContainsFunc(
			records.Payments,
			func(row ledger.Payment) bool { return row.ID == id },
		) ||
		slices.ContainsFunc(
			records.Refunds,
			func(row ledger.Refund) bool { return row.ID == id },
		) ||
		slices.ContainsFunc(records.Payouts, func(row ledger.Payout) bool { return row.ID == id })
}

func editRecord(
	before, after *ledger.Records,
	op *protocol.Operation,
	source string,
) (any, json.RawMessage, *ledger.RuleError) {
	switch op.RecordType {
	case ledger.TypeSettings:
		return editSettings(before, after, op)
	case ledger.TypePerson:
		return editRows(&after.People, op, source, func(row ledger.Person) string { return row.ID })
	case ledger.TypePurchase:
		return editRows(
			&after.Purchases, op, source, func(row ledger.Purchase) string { return row.ID },
		)
	case ledger.TypePayment:
		return editRows(
			&after.Payments, op, source, func(row ledger.Payment) string { return row.ID },
		)
	case ledger.TypeRefund:
		return editRows(
			&after.Refunds,
			op,
			source,
			func(row ledger.Refund) string { return row.ID },
		)
	case ledger.TypePayout:
		return editRows(
			&after.Payouts,
			op,
			source,
			func(row ledger.Payout) string { return row.ID },
		)
	default:
		return nil, nil, invalid("Unknown record type.")
	}
}

func editSettings(
	before, after *ledger.Records,
	op *protocol.Operation,
) (any, json.RawMessage, *ledger.RuleError) {
	record, current, rule := decodeChange(before.Settings, op, ledger.SourceApp)
	if rule == nil {
		after.Settings = record
	}

	return record, current, rule
}

func editRows[T any](
	rows *[]T,
	op *protocol.Operation,
	source string,
	idOf func(T) string,
) (any, json.RawMessage, *ledger.RuleError) {
	index := slices.IndexFunc(*rows, func(row T) bool { return idOf(row) == op.RecordID })

	var existing *T
	if index >= 0 {
		existing = &(*rows)[index]
	}

	record, current, rule := decodeChange(existing, op, source)
	if rule != nil {
		return nil, current, rule
	}

	switch op.Kind {
	case ledger.KindCreate:
		*rows = append(slices.Clone(*rows), *record)
	case ledger.KindUpdate:
		*rows = slices.Clone(*rows)
		(*rows)[index] = *record
	case ledger.KindDelete:
		*rows = slices.Delete(slices.Clone(*rows), index, index+1)
	}

	return record, nil, nil
}
