package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/zekihan/go-commons/sqlitestore"
)

// Store wraps the shared SQLite store. Its single connection serializes
// transactions, including writes to the auth tables.
type Store struct {
	*sqlitestore.Store
}

// Tx is a single database transaction. Application queries run through
// Tx.Inner.
type Tx struct {
	*sqlitestore.Tx
}

type Meta struct {
	Generation string `db:"generation"`
	Revision   int64  `db:"revision"`
}

// Open opens (creating if needed) and migrates the database at path, enabling
// WAL and foreign keys, then ensures the ledger metadata row exists.
func Open(ctx context.Context, path string) (*Store, error) {
	shared, err := sqlitestore.Open(ctx, path, Migrations)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	st := &Store{Store: shared}

	err = st.Write(ctx, func(ctx context.Context, tx *Tx) error {
		_, execErr := tx.Inner().ExecContext(ctx, `
			INSERT INTO ledger_meta (id, generation, revision) VALUES (1, ?, 0)
			ON CONFLICT (id) DO NOTHING`, uuid.NewString())
		if execErr != nil {
			return fmt.Errorf("initialize ledger metadata: %w", execErr)
		}

		return nil
	})
	if err != nil {
		return nil, errors.Join(err, st.Close())
	}

	return st, nil
}

// Read runs run in a read-only transaction.
func (s *Store) Read(ctx context.Context, run func(context.Context, *Tx) error) error {
	err := s.Store.Read(ctx, func(ctx context.Context, tx *sqlitestore.Tx) error {
		return run(ctx, &Tx{Tx: tx})
	})
	if err != nil {
		return fmt.Errorf("read: %w", err)
	}

	return nil
}

// Write runs run in a write transaction.
func (s *Store) Write(ctx context.Context, run func(context.Context, *Tx) error) error {
	err := s.Store.Write(ctx, func(ctx context.Context, tx *sqlitestore.Tx) error {
		return run(ctx, &Tx{Tx: tx})
	})
	if err != nil {
		return fmt.Errorf("write: %w", err)
	}

	return nil
}

func (tx *Tx) Meta(ctx context.Context) (Meta, error) {
	var meta Meta

	err := tx.Inner().
		GetContext(ctx, &meta, "SELECT generation, revision FROM ledger_meta WHERE id = 1")
	if err != nil {
		return Meta{}, fmt.Errorf("load ledger metadata: %w", err)
	}

	return meta, nil
}

func (tx *Tx) SaveMeta(ctx context.Context, meta Meta) error {
	_, err := tx.Inner().ExecContext(ctx,
		"UPDATE ledger_meta SET generation = ?, revision = ? WHERE id = 1",
		meta.Generation, meta.Revision)
	if err != nil {
		return fmt.Errorf("save ledger metadata: %w", err)
	}

	return nil
}
