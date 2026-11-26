package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type Receipt struct {
	Body      json.RawMessage
	CreatedAt time.Time
	OpID      string
	Status    string
	// Kind, RecordType and RecordID name the operation's target. They are empty
	// for restores and for receipts stored before schema v3.
	Kind       string
	RecordType string
	RecordID   string
	Meta       Meta
	IsRestore  bool
}

func (tx *Tx) Receipt(ctx context.Context, opID string) (Receipt, error) {
	var (
		receipt Receipt
		body    []byte
	)

	// Before v4, every ordinary receipt included blocking and only applied
	// restores had an opId without that field.
	err := tx.Inner().QueryRowxContext(ctx, `
		SELECT status, generation, revision, body,
			COALESCE(is_restore, status = 'applied'
				AND json_type(body, '$.opId') IS 'text'
				AND json_type(body, '$.blocking') IS NULL)
		FROM receipts WHERE op_id = ?`, opID).
		Scan(&receipt.Status, &receipt.Meta.Generation, &receipt.Meta.Revision, &body, &receipt.IsRestore)
	if errors.Is(err, sql.ErrNoRows) {
		return receipt, nil
	}

	if err != nil {
		return Receipt{}, fmt.Errorf("load receipt %q: %w", opID, err)
	}

	receipt.OpID = opID
	receipt.Body = body

	return receipt, nil
}

func (tx *Tx) SaveReceipt(ctx context.Context, receipt *Receipt) error {
	_, err := tx.Inner().ExecContext(ctx, `
		INSERT INTO receipts
			(op_id, status, generation, revision, body, created_at, kind, record_type, record_id, is_restore)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		receipt.OpID, receipt.Status, receipt.Meta.Generation, receipt.Meta.Revision,
		string(receipt.Body), receipt.CreatedAt.UTC().Format(time.RFC3339Nano),
		nullIfEmpty(receipt.Kind), nullIfEmpty(receipt.RecordType), nullIfEmpty(receipt.RecordID),
		receipt.IsRestore)
	if err != nil {
		return fmt.Errorf("save receipt %q: %w", receipt.OpID, err)
	}

	return nil
}

// CreateReceiptTime returns the commit time of the applied receipt opID when
// it is for a create of the given record.
func (tx *Tx) CreateReceiptTime(
	ctx context.Context,
	opID, recordType, recordID string,
) (time.Time, bool, error) {
	var createdAt string

	err := tx.Inner().GetContext(ctx, &createdAt, `
		SELECT created_at FROM receipts
		WHERE op_id = ? AND status = 'applied' AND kind = 'create'
			AND record_type = ? AND record_id = ?`, opID, recordType, recordID)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}

	if err != nil {
		return time.Time{}, false, fmt.Errorf("load create receipt %q: %w", opID, err)
	}

	parsed, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("parse receipt time %q: %w", createdAt, err)
	}

	return parsed, true, nil
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}

	return value
}
