package syncsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

func (svc *Service) Restore(
	ctx context.Context,
	req *protocol.RestoreRequest,
) (*protocol.RestoreResult, error) {
	result := new(protocol.RestoreResult)
	result.OpID = req.OpID

	err := svc.store.Write(ctx, func(ctx context.Context, tx *store.Tx) error {
		stored, err := tx.Receipt(ctx, req.OpID)
		if err != nil {
			return fmt.Errorf("look up restore %q: %w", req.OpID, err)
		}

		if stored.Body != nil {
			err = json.Unmarshal(stored.Body, result)
			if err != nil {
				return fmt.Errorf("decode restore receipt %q: %w", req.OpID, err)
			}

			return nil
		}

		return restore(ctx, tx, req, result, svc.now())
	})
	if err != nil {
		return nil, fmt.Errorf("restore ledger: %w", err)
	}

	return result, nil
}

func restore(
	ctx context.Context,
	tx *store.Tx,
	req *protocol.RestoreRequest,
	result *protocol.RestoreResult,
	now time.Time,
) error {
	meta, err := tx.Meta(ctx)
	if err != nil {
		return fmt.Errorf("read restore revision: %w", err)
	}

	result.Generation = meta.Generation
	result.Revision = meta.Revision

	records, rejection := restoreRecords(req, now)
	if records == nil {
		result.Status = protocol.StatusRejected
		result.Code = new(ledger.CodeInvalid)
		result.Reason = new(rejection)

		return nil
	}

	if meta.Revision != req.ExpectedRevision {
		result.Status = protocol.StatusRejected
		result.Code = new(protocol.CodeRevisionMismatch)
		result.Reason = new("The ledger changed since the restore preview.")

		return nil
	}

	err = tx.ReplaceRecords(ctx, records)
	if err != nil {
		return fmt.Errorf("replace ledger: %w", err)
	}

	meta.Generation = uuid.NewString()
	meta.Revision++

	err = tx.SaveMeta(ctx, meta)
	if err != nil {
		return fmt.Errorf("update restore metadata: %w", err)
	}

	result.Status = protocol.StatusApplied
	result.Generation = meta.Generation
	result.Revision = meta.Revision

	return saveReceipt(ctx, tx, req.OpID, result.Status, meta, now, result)
}

func restoreRecords(req *protocol.RestoreRequest, now time.Time) (*ledger.Records, string) {
	backup := &req.Backup
	if !isUUIDv4(req.OpID) {
		return nil, "Restore operation ID must be a lowercase UUIDv4."
	}

	if backup.Format != protocol.BackupFormat ||
		backup.FormatVersion != protocol.BackupFormatVersion {
		return nil, "Unsupported backup format or version."
	}

	if backup.Currency != ledger.CurrencyTRY {
		return nil, "Backup currency must be TRY."
	}

	today, err := todayInZone(backup.TimeZone, now)
	if err != nil {
		return nil, err.Error()
	}

	records := &ledger.Records{
		Settings: &ledger.Settings{
			ID:       ledger.SettingsID,
			TimeZone: backup.TimeZone,
			Currency: backup.Currency,
			Version:  req.OpID,
		},
		People:    slices.Clone(backup.People),
		Purchases: slices.Clone(backup.Purchases),
		Payments:  slices.Clone(backup.Payments),
		Refunds:   slices.Clone(backup.Refunds),
		Payouts:   slices.Clone(backup.Payouts),
	}

	if !stampBackupVersions(records, req.OpID) {
		return nil, "Backup record IDs must be lowercase UUIDv4."
	}

	rule := ledger.ValidateRecords(records, today)
	if rule != nil {
		return nil, rule.Reason
	}

	return records, ""
}

func stampBackupVersions(records *ledger.Records, version string) bool {
	for index := range records.People {
		if !isUUIDv4(records.People[index].ID) {
			return false
		}

		records.People[index].Version = version
	}

	for index := range records.Purchases {
		if !isUUIDv4(records.Purchases[index].ID) {
			return false
		}

		records.Purchases[index].Version = version
	}

	for index := range records.Payments {
		if !isUUIDv4(records.Payments[index].ID) {
			return false
		}

		records.Payments[index].Version = version
	}

	for index := range records.Refunds {
		if !isUUIDv4(records.Refunds[index].ID) {
			return false
		}

		records.Refunds[index].Version = version
	}

	for index := range records.Payouts {
		if !isUUIDv4(records.Payouts[index].ID) {
			return false
		}

		records.Payouts[index].Version = version
	}

	return true
}
