package mcp

import (
	"testing"
	"time"

	"github.com/zekihan/family-tab/internal/ledger"
)

func undoHarness(t *testing.T) (*harness, string) {
	t.Helper()

	env := newHarness(t)
	env.setup()

	mom := env.addPerson("Mom", nil)

	return env, mom
}

func TestUndoAgentRecordWithinWindow(t *testing.T) {
	t.Parallel()

	env, mom := undoHarness(t)

	result := env.mustCall("record_payment", map[string]any{"personId": mom, "amount": "10"})
	id := text(t, result, "payment", "id")

	env.clock.Advance(23 * time.Hour)

	undone := env.mustCall("undo", map[string]any{"recordId": id})
	expect(t, undone, map[string]any{"deleted": true, "recordType": "payment", "recordId": id})

	if len(env.snapshot().Payments) != 0 {
		t.Fatal("payment was not deleted")
	}
}

func TestUndoRefusesAppRecord(t *testing.T) {
	t.Parallel()

	env, mom := undoHarness(t)
	id := env.addAppPayment(mom, 500, "2026-11-22")

	env.mustFail("undo", map[string]any{"recordId": id}, "not created through the agent")

	if len(env.snapshot().Payments) != 1 {
		t.Fatal("an app payment was deleted")
	}
}

func TestUndoRefusesEditedRecord(t *testing.T) {
	t.Parallel()

	env, mom := undoHarness(t)

	result := env.mustCall("add_purchase", map[string]any{
		"personId": mom, "item": "Kettle", "price": "100",
	})
	id := text(t, result, "purchase", "id")

	env.update(ledger.TypePurchase, id, env.purchase(id).Version, map[string]any{"note": "edited"})

	env.mustFail("undo", map[string]any{"recordId": id}, "changed after it was created")

	if env.purchase(id).Note == nil {
		t.Fatal("the edited purchase was changed")
	}
}

func TestUndoRefusesOldRecord(t *testing.T) {
	t.Parallel()

	env, mom := undoHarness(t)

	result := env.mustCall("record_payment", map[string]any{"personId": mom, "amount": "20"})
	id := text(t, result, "payment", "id")

	env.clock.Advance(25 * time.Hour)

	env.mustFail("undo", map[string]any{"recordId": id}, "more than 24 hours")

	if len(env.snapshot().Payments) != 1 {
		t.Fatal("an old payment was deleted")
	}
}

func TestUndoPurchaseWithRefunds(t *testing.T) {
	t.Parallel()

	env, mom := undoHarness(t)

	result := env.mustCall("add_purchase", map[string]any{
		"personId": mom, "item": "Lamp", "price": "100",
	})
	id := text(t, result, "purchase", "id")

	refund := env.mustCall("add_refund", map[string]any{"purchaseId": id, "amount": "10"})

	env.mustFail("undo", map[string]any{"recordId": id}, "purchase_has_refunds")

	env.mustCall("undo", map[string]any{"recordId": text(t, refund, "refund", "id")})
	env.mustCall("undo", map[string]any{"recordId": id})

	if len(env.snapshot().Purchases) != 0 || len(env.snapshot().Refunds) != 0 {
		t.Fatal("the purchase and its refund were not deleted")
	}
}

func TestUndoRefusesOtherRecords(t *testing.T) {
	t.Parallel()

	env, mom := undoHarness(t)

	env.mustFail("undo", map[string]any{"recordId": mom}, "Undo only deletes")
	env.mustFail("undo", map[string]any{"recordId": "missing"}, "Undo only deletes")
}

func TestCreatedAtMatchesOnlyCreates(t *testing.T) {
	t.Parallel()

	env, mom := undoHarness(t)

	result := env.mustCall("record_payment", map[string]any{"personId": mom, "amount": "10"})
	id := text(t, result, "payment", "id")
	version := env.snapshot().Payments[0].Version

	createdAt, found, err := env.svc.CreatedAt(t.Context(), version, ledger.TypePayment, id)
	if err != nil || !found || !createdAt.Equal(env.clock.Now()) {
		t.Fatalf("CreatedAt = %v, %v, %v", createdAt, found, err)
	}

	for _, test := range []struct{ opID, recordType, recordID string }{
		{version, ledger.TypePurchase, id},
		{version, ledger.TypePayment, mom},
		{mom, ledger.TypePayment, id},
	} {
		_, found, err = env.svc.CreatedAt(t.Context(), test.opID, test.recordType, test.recordID)
		if err != nil || found {
			t.Errorf("CreatedAt(%+v) = %v, %v", test, found, err)
		}
	}
}
