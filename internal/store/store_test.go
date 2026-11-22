package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestOpenReopen(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "family tab #1.db")

	st, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}

	for pragma, want := range map[string]string{
		"PRAGMA user_version": "2",
		"PRAGMA journal_mode": "wal",
		"PRAGMA foreign_keys": "1",
		"PRAGMA busy_timeout": "5000",
	} {
		var got string

		err = st.DB().GetContext(t.Context(), &got, pragma)
		if err != nil || got != want {
			t.Fatalf("%s = %q, want %q, error %v", pragma, got, want, err)
		}
	}

	first := readMeta(t, st)

	generation, err := uuid.Parse(first.Generation)
	if err != nil || generation.Version() != 4 || first.Revision != 0 {
		t.Fatalf("invalid initial metadata: %+v", first)
	}

	err = st.Close()
	if err != nil {
		t.Fatal(err)
	}

	st, err = Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	got := readMeta(t, st)
	if got != first {
		t.Fatalf("reopened metadata = %+v, want %+v", got, first)
	}
}

func readMeta(t *testing.T, st *Store) Meta {
	t.Helper()

	var meta Meta

	err := st.Read(t.Context(), func(ctx context.Context, tx *Tx) error {
		var readErr error

		meta, readErr = tx.Meta(ctx)

		return readErr
	})
	if err != nil {
		t.Fatal(err)
	}

	return meta
}
