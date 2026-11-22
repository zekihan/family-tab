// Package syncsvc implements the server side of sync (DESIGN.md section 7,
// Sync rule 4 and Backup and restore): validating and committing operations
// with their receipts, snapshots, and restores.
package syncsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

type Service struct {
	store *store.Store
	now   func() time.Time
}

func New(st *store.Store, now func() time.Time) *Service {
	return &Service{store: st, now: now}
}

func (svc *Service) Snapshot(ctx context.Context) (*protocol.Snapshot, error) {
	snapshot := new(protocol.Snapshot)

	err := svc.store.Read(ctx, func(ctx context.Context, tx *store.Tx) error {
		meta, err := tx.Meta(ctx)
		if err != nil {
			return fmt.Errorf("read snapshot revision: %w", err)
		}

		records, err := tx.Records(ctx)
		if err != nil {
			return fmt.Errorf("read snapshot records: %w", err)
		}

		*snapshot = protocol.Snapshot{
			Records: *records, Generation: meta.Generation, Revision: meta.Revision,
		}

		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("snapshot ledger: %w", err)
	}

	return snapshot, nil
}

func (svc *Service) Receipts(
	ctx context.Context,
	req *protocol.ReceiptsRequest,
) (*protocol.ReceiptsResponse, error) {
	response := &protocol.ReceiptsResponse{
		Generation: "",
		Receipts:   make([]protocol.Receipt, 0, len(req.OpIDs)),
	}

	err := svc.store.Read(ctx, func(ctx context.Context, tx *store.Tx) error {
		meta, err := tx.Meta(ctx)
		if err != nil {
			return fmt.Errorf("read receipts generation: %w", err)
		}

		response.Generation = meta.Generation

		for _, opID := range req.OpIDs {
			stored, lookupErr := tx.Receipt(ctx, opID)
			if lookupErr != nil {
				return fmt.Errorf("look up receipt %q: %w", opID, lookupErr)
			}

			if stored.Body == nil {
				continue
			}

			var receipt protocol.Receipt

			err = json.Unmarshal(stored.Body, &receipt)
			if err != nil {
				return fmt.Errorf("decode receipt %q: %w", opID, err)
			}

			fillReceiptFields(&receipt)
			response.Receipts = append(response.Receipts, receipt)
		}

		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read sync state: %w", err)
	}

	return response, nil
}

func (svc *Service) Apply(
	ctx context.Context,
	req *protocol.OpsRequest,
) (*protocol.OpsResponse, error) {
	response := &protocol.OpsResponse{
		Generation: "",
		Results:    make([]protocol.OpResult, 0, len(req.Items)),
	}
	for index := range req.Items {
		item := &req.Items[index]

		err := svc.store.Write(ctx, func(ctx context.Context, tx *store.Tx) error {
			result, err := svc.applyItem(ctx, tx, item)
			if err != nil {
				return err
			}

			response.Results = append(response.Results, result)

			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("apply operation %q: %w", item.Op.ID, err)
		}
	}

	err := svc.store.Read(ctx, func(ctx context.Context, tx *store.Tx) error {
		meta, err := tx.Meta(ctx)
		if err != nil {
			return fmt.Errorf("read sync generation: %w", err)
		}

		response.Generation = meta.Generation

		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read sync state: %w", err)
	}

	return response, nil
}

func (svc *Service) applyItem(
	ctx context.Context,
	tx *store.Tx,
	item *protocol.OpsItem,
) (protocol.OpResult, error) {
	op := &item.Op

	stored, err := tx.Receipt(ctx, op.ID)
	if err != nil {
		return protocol.OpResult{}, fmt.Errorf("look up operation %q: %w", op.ID, err)
	}

	if stored.Body != nil {
		var result protocol.Receipt

		err = json.Unmarshal(stored.Body, &result)
		if err != nil {
			return protocol.OpResult{}, fmt.Errorf("decode operation receipt %q: %w", op.ID, err)
		}

		fillReceiptFields(&result)

		return protocol.OpResult(result), nil
	}

	for _, dep := range item.Deps {
		receipt, lookupErr := tx.Receipt(ctx, dep)
		if lookupErr != nil {
			return protocol.OpResult{}, fmt.Errorf("look up dependency %q: %w", dep, lookupErr)
		}

		if receipt.Status != protocol.StatusApplied {
			return protocol.OpResult{
				OpID:       op.ID,
				Status:     protocol.StatusSkipped,
				Code:       new(protocol.CodeDependencyNotApplied),
				Reason:     nil,
				Generation: "",
				Current:    nil,
				Blocking:   nil,
				Revision:   0,
			}, nil
		}
	}

	meta, err := tx.Meta(ctx)
	if err != nil {
		return protocol.OpResult{}, fmt.Errorf("read operation generation: %w", err)
	}

	if op.Generation != meta.Generation {
		return protocol.OpResult{
			OpID: op.ID, Status: protocol.StatusHeld, Code: new(protocol.CodeGenerationMismatch),
			Generation: meta.Generation, Reason: nil, Current: nil, Blocking: nil, Revision: 0,
		}, nil
	}

	receipt, err := commitOperation(ctx, tx, op, meta, svc.now())
	if err != nil {
		return protocol.OpResult{}, err
	}

	return protocol.OpResult(receipt), nil
}

func saveReceipt(
	ctx context.Context,
	tx *store.Tx,
	opID, status string,
	meta store.Meta,
	now time.Time,
	result any,
) error {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("encode receipt %q: %w", opID, err)
	}

	err = tx.SaveReceipt(ctx, &store.Receipt{
		OpID: opID, Status: status, Meta: meta, CreatedAt: now, Body: body,
	})
	if err != nil {
		return fmt.Errorf("record %q outcome: %w", opID, err)
	}

	return nil
}

func fillReceiptFields(receipt *protocol.Receipt) {
	if receipt.Blocking == nil {
		receipt.Blocking = []string{}
	}

	if receipt.Current == nil {
		receipt.Current = json.RawMessage("null")
	}
}
