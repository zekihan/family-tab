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
	Meta      Meta
}

func (tx *Tx) Receipt(ctx context.Context, opID string) (Receipt, error) {
	var (
		receipt Receipt
		body    []byte
	)

	err := tx.tx.QueryRowxContext(ctx,
		"SELECT status, generation, revision, body FROM receipts WHERE op_id = ?", opID).
		Scan(&receipt.Status, &receipt.Meta.Generation, &receipt.Meta.Revision, &body)
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
	_, err := tx.tx.ExecContext(ctx, `
		INSERT INTO receipts (op_id, status, generation, revision, body, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		receipt.OpID, receipt.Status, receipt.Meta.Generation, receipt.Meta.Revision,
		string(receipt.Body), receipt.CreatedAt.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("save receipt %q: %w", receipt.OpID, err)
	}

	return nil
}
