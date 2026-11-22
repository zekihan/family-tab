package store

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/jmoiron/sqlx"

	"github.com/zekihan/family-tab/internal/ledger"
)

func TestMigrateVersionOneDatabase(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "v1.db")
	writeVersionOneDatabase(t, path)

	st, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	records := readRecords(t, st)
	if len(records.People) != 1 || records.People[0].Aliases == nil ||
		len(records.People[0].Aliases) != 0 ||
		records.Purchases[0].Source != ledger.SourceApp ||
		records.Payments[0].Source != ledger.SourceApp {
		t.Fatalf("migrated records = %+v", records)
	}

	records.People[0].Aliases = []string{"Annem", "Anne"}
	records.Payments[0].Source = ledger.SourceAgent

	err = st.Write(t.Context(), func(ctx context.Context, tx *Tx) error {
		saveErr := tx.SaveRecord(ctx, &records.People[0])
		if saveErr != nil {
			return saveErr
		}

		return tx.SaveRecord(ctx, &records.Payments[0])
	})
	if err != nil {
		t.Fatal(err)
	}

	records = readRecords(t, st)
	if !slices.Equal(records.People[0].Aliases, []string{"Annem", "Anne"}) ||
		records.Payments[0].Source != ledger.SourceApp {
		t.Fatalf("saved records = %+v", records)
	}
}

func writeVersionOneDatabase(t *testing.T, path string) {
	t.Helper()

	old, err := sqlx.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = old.Close() }()

	_, err = old.ExecContext(t.Context(), Migrations[0]+`
		PRAGMA user_version = 1;
		INSERT INTO people (id, name, payday, archived, version) VALUES ('mom', 'Mom', NULL, 0, 'v1');
		INSERT INTO purchases (id, person_id, item, total_minor, bought_on, plan, version)
			VALUES ('p', 'mom', 'Vacuum', 600, '2025-08-01', 'once', 'v1');
		INSERT INTO payments (id, person_id, amount_minor, paid_on, version)
			VALUES ('pay', 'mom', 500, '2025-08-02', 'v1');`)
	if err != nil {
		t.Fatal(err)
	}
}

func readRecords(t *testing.T, st *Store) *ledger.Records {
	t.Helper()

	var records *ledger.Records

	err := st.Read(t.Context(), func(ctx context.Context, tx *Tx) error {
		var readErr error

		records, readErr = tx.Records(ctx)

		return readErr
	})
	if err != nil {
		t.Fatal(err)
	}

	return records
}
