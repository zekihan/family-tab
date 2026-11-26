package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestCreateReceiptTime(t *testing.T) {
	t.Parallel()

	st, err := Open(t.Context(), filepath.Join(t.TempDir(), "receipts.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	committed := time.Date(2026, time.November, 22, 7, 30, 0, 123, time.UTC)

	err = st.Write(t.Context(), func(ctx context.Context, tx *Tx) error {
		for _, receipt := range []*Receipt{
			{
				Body: []byte("{}"), CreatedAt: committed, OpID: "create", Status: "applied",
				Kind: "create", RecordType: "payment", RecordID: "pay", Meta: Meta{Generation: "g", Revision: 1},
				IsRestore: false,
			},
			{
				Body: []byte("{}"), CreatedAt: committed, OpID: "update", Status: "applied",
				Kind: "update", RecordType: "payment", RecordID: "pay", Meta: Meta{Generation: "g", Revision: 1},
				IsRestore: false,
			},
			{
				Body: []byte("{}"), CreatedAt: committed, OpID: "rejected", Status: "rejected",
				Kind: "create", RecordType: "payment", RecordID: "pay", Meta: Meta{Generation: "g", Revision: 1},
				IsRestore: false,
			},
			{
				Body: []byte("{}"), CreatedAt: committed, OpID: "restore", Status: "applied",
				Kind: "", RecordType: "", RecordID: "", Meta: Meta{Generation: "g", Revision: 1},
				IsRestore: true,
			},
		} {
			saveErr := tx.SaveReceipt(ctx, receipt)
			if saveErr != nil {
				return saveErr
			}
		}

		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	for opID, want := range map[string]bool{
		"create": true, "update": false, "rejected": false, "restore": false, "missing": false,
	} {
		var (
			got   time.Time
			found bool
		)

		err = st.Read(t.Context(), func(ctx context.Context, tx *Tx) error {
			var readErr error

			got, found, readErr = tx.CreateReceiptTime(ctx, opID, "payment", "pay")

			return readErr
		})
		if err != nil || found != want || (want && !got.Equal(committed)) {
			t.Errorf(
				"CreateReceiptTime(%q) = %v, %v, %v; want found %v",
				opID,
				got,
				found,
				err,
				want,
			)
		}
	}
}
