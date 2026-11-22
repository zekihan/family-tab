package syncsvc

import (
	"encoding/json"
	"errors"
	"fmt"

	jsonv2 "encoding/json/v2"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
)

var errBackupShape = errors.New("invalid backup shape")

func decodeBackup(raw json.RawMessage) (*protocol.BackupFile, error) {
	backup := new(protocol.BackupFile)

	err := jsonv2.Unmarshal(raw, backup, jsonv2.RejectUnknownMembers(true))
	if err != nil {
		return nil, fmt.Errorf("decode backup: %w", err)
	}

	err = validateBackupShape(raw)
	if err != nil {
		return nil, err
	}

	return backup, nil
}

func validateBackupShape(raw json.RawMessage) error {
	var fields struct {
		People    []json.RawMessage `json:"people"`
		Purchases []json.RawMessage `json:"purchases"`
		Payments  []json.RawMessage `json:"payments"`
		Refunds   []json.RawMessage `json:"refunds"`
		Payouts   []json.RawMessage `json:"payouts"`
		Unapplied []recordFields    `json:"unapplied"`
	}

	err := json.Unmarshal(raw, &fields)
	if err != nil {
		return fmt.Errorf("read backup fields: %w", err)
	}

	for _, collection := range []struct {
		record any
		name   string
		rows   []json.RawMessage
	}{
		{new(ledger.Person), "people", fields.People},
		{new(ledger.Purchase), "purchases", fields.Purchases},
		{new(ledger.Payment), "payments", fields.Payments},
		{new(ledger.Refund), "refunds", fields.Refunds},
		{new(ledger.Payout), "payouts", fields.Payouts},
	} {
		err = validateBackupRecords(collection.name, collection.rows, collection.record)
		if err != nil {
			return err
		}
	}

	return validateUnappliedShape(fields.Unapplied)
}

func validateBackupRecords(collection string, rows []json.RawMessage, record any) error {
	_, shape, err := encodeRecord(record)
	if err != nil {
		return err
	}

	for index, row := range rows {
		fields, decodeErr := decodeFields(row, shape)
		if decodeErr != nil {
			return fmt.Errorf("backup %s record %d: %w", collection, index+1, decodeErr)
		}

		for key := range shape {
			if key != "version" && fields[key] == nil {
				return fmt.Errorf(
					"%w: %s record %d is missing %s", errBackupShape, collection, index+1, key,
				)
			}
		}
	}

	return nil
}

func validateUnappliedShape(rows []recordFields) error {
	for index, row := range rows {
		for _, key := range []string{"order", "op", "dependencies", "reason"} {
			if row[key] == nil || (key != "reason" && string(row[key]) == "null") {
				return fmt.Errorf(
					"%w: unapplied operation %d needs %s", errBackupShape, index+1, key,
				)
			}
		}

		var op recordFields

		err := json.Unmarshal(row["op"], &op)
		if err != nil {
			return fmt.Errorf("read unapplied operation %d: %w", index+1, err)
		}

		if flag := op["alreadyReturned"]; flag != nil &&
			(!matchesString(op["recordType"], ledger.TypePayout) || string(flag) == "null") {
			return fmt.Errorf(
				"%w: unapplied operation %d: alreadyReturned must be a boolean on a payout",
				errBackupShape, index+1,
			)
		}
	}

	return nil
}
