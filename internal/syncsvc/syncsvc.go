// Package syncsvc implements the server side of sync (DESIGN.md section 7,
// Sync rule 4 and Backup and restore): validating and committing operations
// with their receipts, snapshots, and restores.
package syncsvc

import (
	"context"
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

func (s *Service) Snapshot(ctx context.Context) (*protocol.Snapshot, error) { return nil, nil }

func (s *Service) Receipts(
	ctx context.Context,
	req *protocol.ReceiptsRequest,
) (*protocol.ReceiptsResponse, error) {
	return nil, nil
}

func (s *Service) Apply(
	ctx context.Context,
	req *protocol.OpsRequest,
) (*protocol.OpsResponse, error) {
	return nil, nil
}

func (s *Service) Restore(
	ctx context.Context,
	req *protocol.RestoreRequest,
) (*protocol.RestoreResult, error) {
	return nil, nil
}
