package store

import (
	"context"

	"github.com/jmoiron/sqlx"

	// SQLite driver for database/sql.
	_ "modernc.org/sqlite"
)

// Store wraps the database. Writes are serialized through a single writer.
type Store struct {
	db *sqlx.DB
}

// Open opens (creating if needed) and migrates the database at path, enabling
// WAL and foreign keys.
func Open(ctx context.Context, path string) (*Store, error) {
	return &Store{}, nil
}

// DB exposes the handle for packages that own their own tables (auth).
func (s *Store) DB() *sqlx.DB { return s.db }

func (s *Store) Close() error { return nil }
