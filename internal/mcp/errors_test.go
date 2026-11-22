package mcp

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/store"
	"github.com/zekihan/family-tab/internal/syncsvc"
)

// closedService returns a service whose ledger database is already closed, so
// every store call fails with an internal driver error.
func closedService(t *testing.T) *service {
	t.Helper()

	st, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}

	svc := &service{ledger: syncsvc.New(st, time.Now), now: time.Now}

	err = st.Close()
	if err != nil {
		t.Fatal(err)
	}

	return svc
}

func expectSanitized(t *testing.T, err error) {
	t.Helper()

	if err == nil {
		t.Fatal("expected an error")
	}

	for _, leaked := range []string{"sql:", "sqlite", "database is closed"} {
		if strings.Contains(err.Error(), leaked) {
			t.Fatalf("tool error %q leaks internal detail %q", err.Error(), leaked)
		}
	}
}

func TestToolErrorsHideInternalErrors(t *testing.T) {
	t.Parallel()

	svc := closedService(t)

	_, _, err := svc.listPeople(t.Context(), nil, emptyInput{})
	expectSanitized(t, err)

	_, _, err = svc.recordPayment(t.Context(), nil, recordPaymentInput{
		PersonID: "person", Amount: "10", PaidOn: "", Note: "",
	})
	expectSanitized(t, err)

	target := &undoTarget{
		record: nil, recordType: ledger.TypePayment, version: "create-op",
		source: ledger.SourceAgent, summary: "payment",
	}
	expectSanitized(t, svc.checkUndo(t.Context(), target, "record"))
}
