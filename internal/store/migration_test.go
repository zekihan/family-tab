package store

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"

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
	assertVersionOneDefaults(t, records)

	if meta := readMeta(t, st); meta.Generation != "existing" || meta.Revision != 7 {
		t.Fatalf("migration replaced metadata: %+v", meta)
	}

	assertLegacyReceipt(t, st)

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

func assertVersionOneDefaults(t *testing.T, records *ledger.Records) {
	t.Helper()

	if len(records.People) != 1 || records.People[0].Aliases == nil ||
		len(records.People[0].Aliases) != 0 ||
		len(records.Purchases) != 1 || len(records.Payments) != 1 || len(records.Refunds) != 1 ||
		records.Refunds[0].Source != ledger.SourceApp ||
		records.Purchases[0].Source != ledger.SourceApp ||
		records.Payments[0].Source != ledger.SourceApp {
		t.Fatalf("migrated records = %+v", records)
	}
}

func assertLegacyReceipt(t *testing.T, st *Store) {
	t.Helper()

	var (
		receipt Receipt
		created time.Time
		found   bool
	)

	err := st.Read(t.Context(), func(ctx context.Context, tx *Tx) error {
		var err error

		receipt, err = tx.Receipt(ctx, "v1")
		if err != nil {
			return err
		}

		created, found, err = tx.CreateReceiptTime(ctx, "v1", ledger.TypePerson, "mom")

		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	if receipt.Status != "applied" || string(receipt.Body) != `{"status":"applied"}` ||
		receipt.Meta.Generation != "existing" || receipt.Meta.Revision != 7 {
		t.Fatalf("migration changed old receipt: %+v", receipt)
	}

	if found || !created.IsZero() {
		t.Fatalf("old receipt gained an undo target: %v, %v", created, found)
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
		INSERT INTO ledger_meta (id, generation, revision) VALUES (1, 'existing', 7);
		INSERT INTO receipts (op_id, status, generation, revision, body, created_at)
			VALUES ('v1', 'applied', 'existing', 7, '{"status":"applied"}', '2025-08-02T09:00:00Z');
		INSERT INTO people (id, name, payday, archived, version) VALUES ('mom', 'Mom', NULL, 0, 'v1');
		INSERT INTO purchases (id, person_id, item, total_minor, bought_on, plan, version)
			VALUES ('p', 'mom', 'Vacuum', 600, '2025-08-01', 'once', 'v1');
		INSERT INTO payments (id, person_id, amount_minor, paid_on, version)
			VALUES ('pay', 'mom', 500, '2025-08-02', 'v1');
		INSERT INTO refunds (id, purchase_id, amount_minor, refunded_on, version)
			VALUES ('ref', 'p', 100, '2025-08-03', 'v1');`)
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
