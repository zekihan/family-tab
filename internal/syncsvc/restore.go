package syncsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

var backupTimestamp = regexp.MustCompile(
	`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|\+00:00)$`,
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

	if req.RawBackup != nil {
		var err error

		backup, err = decodeBackup(req.RawBackup)
		if err != nil {
			return nil, err.Error()
		}
	}

	if backup.Format != protocol.BackupFormat ||
		backup.FormatVersion != protocol.BackupFormatVersion {
		return nil, "Unsupported backup format or version."
	}

	if missing := missingBackupField(backup); missing != "" {
		return nil, "Backup is missing " + missing + "."
	}

	if backup.Currency != ledger.CurrencyTRY {
		return nil, "Backup currency must be TRY."
	}

	if !validBackupTimestamp(backup.ExportedAt) {
		return nil, "Backup exportedAt must be an RFC 3339 UTC timestamp."
	}

	err := validateUnapplied(backup.Unapplied)
	if err != nil {
		return nil, err.Error()
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

	if !validSources(records) {
		return nil, `Backup record sources must be "app" or "agent".`
	}

	rule := ledger.ValidateRecords(records, today)
	if rule != nil {
		return nil, rule.Reason
	}

	return records, ""
}

func validateUnapplied(rows []protocol.UnappliedOperation) error {
	const maxSafeInteger = 1<<53 - 1

	orderByID := make(map[string]int, len(rows))
	for index := range rows {
		row := &rows[index]
		if row.Order < 0 || int64(row.Order) > maxSafeInteger {
			return fmt.Errorf(
				"%w: unapplied operation %d has an invalid order",
				errPayload,
				index+1,
			)
		}

		if _, exists := orderByID[row.Op.ID]; exists {
			return fmt.Errorf("%w: duplicate unapplied operation ID %q", errPayload, row.Op.ID)
		}

		orderByID[row.Op.ID] = row.Order
	}

	for index := range rows {
		row := &rows[index]

		err := validateUnappliedDependencies(row, orderByID)
		if err == nil {
			err = validateUnappliedOperation(&row.Op)
		}

		if err != nil {
			return fmt.Errorf("unapplied operation %d: %w", index+1, err)
		}
	}

	return nil
}

func validateUnappliedDependencies(
	row *protocol.UnappliedOperation,
	orderByID map[string]int,
) error {
	if row.Dependencies == nil {
		return fmt.Errorf("%w: dependencies must be an array", errPayload)
	}

	for _, id := range row.Dependencies {
		order, found := orderByID[id]
		if !found || order >= row.Order {
			return fmt.Errorf(
				"%w: dependency %q must reference an earlier unapplied operation",
				errPayload,
				id,
			)
		}
	}

	return nil
}

func validateUnappliedOperation(op *protocol.Operation) error {
	rule := validateOperation(op)
	if rule != nil {
		return fmt.Errorf("%w: %s", errPayload, rule.Reason)
	}

	if op.Generation == "" || !validBackupTimestamp(op.CreatedAt) {
		return fmt.Errorf("%w: expected a generation and an RFC 3339 UTC createdAt", errPayload)
	}

	if (op.Kind == ledger.KindUpdate || op.Kind == ledger.KindDelete) &&
		(op.BaseVersion == nil || *op.BaseVersion == "") {
		return fmt.Errorf("%w: an update or delete needs a baseVersion", errPayload)
	}

	return validateUnappliedPayload(op)
}

func validateUnappliedPayload(op *protocol.Operation) error {
	switch op.RecordType {
	case ledger.TypeSettings:
		return validateBackupPayload[ledger.Settings](op)
	case ledger.TypePerson:
		return validateBackupPayload[ledger.Person](op)
	case ledger.TypePurchase:
		return validateBackupPayload[ledger.Purchase](op)
	case ledger.TypePayment:
		return validateBackupPayload[ledger.Payment](op)
	case ledger.TypeRefund:
		return validateBackupPayload[ledger.Refund](op)
	case ledger.TypePayout:
		return validateBackupPayload[ledger.Payout](op)
	default:
		return fmt.Errorf("%w: unknown record type %q", errPayload, op.RecordType)
	}
}

func validBackupTimestamp(value string) bool {
	if !backupTimestamp.MatchString(value) {
		return false
	}

	stamp, err := time.Parse(time.RFC3339, value)

	return err == nil && stamp.Year() > 0
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

func validSources(records *ledger.Records) bool {
	valid := func(source string) bool {
		return source == ledger.SourceApp || source == ledger.SourceAgent
	}

	return !slices.ContainsFunc(records.Purchases, func(row ledger.Purchase) bool {
		return !valid(row.Source)
	}) && !slices.ContainsFunc(records.Payments, func(row ledger.Payment) bool {
		return !valid(row.Source)
	}) && !slices.ContainsFunc(records.Refunds, func(row ledger.Refund) bool {
		return !valid(row.Source)
	})
}

// missingBackupField names the first required field a decoded backup lacks.
// JSON decoding leaves an absent array nil and an empty one non-nil, so a
// file without a collection is rejected instead of erasing those records.
func missingBackupField(backup *protocol.BackupFile) string {
	required := []struct {
		name    string
		missing bool
	}{
		{"exportedAt", backup.ExportedAt == ""},
		{"timeZone", backup.TimeZone == ""},
		{"people", backup.People == nil},
		{"purchases", backup.Purchases == nil},
		{"payments", backup.Payments == nil},
		{"refunds", backup.Refunds == nil},
		{"payouts", backup.Payouts == nil},
		{"unapplied", backup.Unapplied == nil},
	}

	for _, field := range required {
		if field.missing {
			return field.name
		}
	}

	return ""
}
