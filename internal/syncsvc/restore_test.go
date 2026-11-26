package syncsvc

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

func TestRestoreAndRetry(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	create := createOp(generation, ledger.TypePerson, personID, personPayload)
	original := apply(t, svc, item(create))[0]
	req := restoreRequest()

	req.Backup.People = []ledger.Person{
		{
			ID: personID, Name: "Imported", Version: uuid.NewString(), Payday: nil,
			Archived: false, Aliases: []string{"Annem"},
		},
	}
	req.Backup.Payments = []ledger.Payment{
		{
			ID:          uuid.NewString(),
			PersonID:    personID,
			AmountMinor: 500,
			PaidOn:      "2025-01-01",
			Note:        nil,
			Source:      "mcp",
			Version:     "",
		},
	}

	badSource := restoreOK(t, svc, req)
	if badSource.Code == nil || *badSource.Code != ledger.CodeInvalid {
		t.Fatalf("restore with an unknown source accepted: %+v", badSource)
	}

	req.Backup.Payments[0].Source = ledger.SourceAgent

	mismatch := restoreOK(t, svc, req)
	if mismatch.Code == nil || *mismatch.Code != protocol.CodeRevisionMismatch ||
		mismatch.Revision != 2 {
		t.Fatalf("unexpected mismatch result: %+v", mismatch)
	}

	req.ExpectedRevision = 2
	result := restoreOK(t, svc, req)

	got := snapshot(t, svc)
	if result.Status != protocol.StatusApplied || result.Code != nil || got.Revision != 3 ||
		result.Revision != got.Revision || got.Generation == generation || got.Generation != result.Generation {
		t.Fatalf("restore = %+v, snapshot = %+v", result, got)
	}

	assertRestoredRows(t, got, req.OpID)

	assertRestoreRetry(t, svc, req, result)
	assertReceiptsSurvive(t, svc, create, &original, req.OpID, got.Generation)

	stale := createOp(generation, ledger.TypePerson, personID, personPayload)
	assertResult(
		t,
		apply(t, svc, item(stale))[0],
		protocol.StatusHeld,
		protocol.CodeGenerationMismatch,
		0,
	)
}

func TestRestoreRejectsReceiptFromOrdinaryOperation(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	create := createOp(generation, ledger.TypePerson, personID, personPayload)
	original := apply(t, svc, item(create))[0]
	assertResult(t, original, protocol.StatusApplied, "", 2)
	before := snapshot(t, svc)

	req := restoreRequest()
	req.OpID = create.ID
	req.ExpectedRevision = before.Revision
	req.Backup.People = slices.Clone(before.People)
	req.Backup.People[0].Name = "Imported"

	result := restoreOK(t, svc, req)
	if result.Status != protocol.StatusRejected || result.Code == nil ||
		*result.Code != protocol.CodeOperationIDConflict || result.Generation != before.Generation ||
		result.Revision != before.Revision {
		t.Fatalf("restore with an ordinary operation ID = %+v", result)
	}

	if got := snapshot(t, svc); !reflect.DeepEqual(got, before) {
		t.Fatalf("restore with a conflicting ID changed the ledger: %+v", got)
	}

	assertOperationReplay(t, svc, create, &original)
}

func TestRestoreReceiptAfterRestart(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name   string
		legacy bool
	}{{"current", false}, {"legacy", true}} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			path := filepath.Join(t.TempDir(), "restore.db")
			svc := openRestoreTestService(t, path)
			before := snapshot(t, svc)
			setup := createOp(
				before.Generation,
				ledger.TypeSettings,
				ledger.SettingsID,
				settingsPayload,
			)
			original := apply(t, svc, item(setup))[0]
			req := restoreRequest()
			req.ExpectedRevision = original.Revision
			result := restoreOK(t, svc, req)

			if result.Status != protocol.StatusApplied ||
				result.Revision != req.ExpectedRevision+1 ||
				result.Generation == before.Generation {
				t.Fatalf("fresh restore = %+v", result)
			}

			restored := snapshot(t, svc)
			if test.legacy {
				// Preserve the old receipt bodies and remove the v4 discriminator.
				_, err := svc.store.DB().
					ExecContext(t.Context(), "UPDATE receipts SET is_restore = NULL")
				if err != nil {
					t.Fatal(err)
				}
			}

			err := svc.store.Close()
			if err != nil {
				t.Fatal(err)
			}

			svc = openRestoreTestService(t, path)
			assertRestoreRetry(t, svc, req, result)
			assertReceiptsSurvive(t, svc, setup, &original, req.OpID, restored.Generation)
			assertRestoreReceiptRejectsWrites(t, svc, req.OpID, restored)
		})
	}
}

func openRestoreTestService(t *testing.T, path string) *Service {
	t.Helper()

	db, err := store.Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = db.Close() })

	return New(db, time.Now)
}

func assertRestoreReceiptRejectsWrites(
	t *testing.T, svc *Service, restoreID string, before *protocol.Snapshot,
) {
	t.Helper()

	create := createOp(before.Generation, ledger.TypePerson, personID, personPayload)
	dependent := item(create, restoreID)
	create.ID = restoreID

	results := apply(t, svc, item(create), dependent)
	assertResult(
		t,
		results[0],
		protocol.StatusRejected,
		protocol.CodeOperationIDConflict,
		before.Revision,
	)
	assertResult(t, results[1], protocol.StatusSkipped, protocol.CodeDependencyNotApplied, 0)

	if got := snapshot(t, svc); !reflect.DeepEqual(got, before) {
		t.Fatalf("writes with a restore receipt changed the ledger: %+v", got)
	}
}

func assertRestoredRows(t *testing.T, got *protocol.Snapshot, version string) {
	t.Helper()

	if len(got.People) != 1 || got.People[0].Name != "Imported" ||
		got.People[0].Version != version ||
		len(got.Payments) != 1 ||
		got.Payments[0].Version != version || got.Payments[0].Source != ledger.SourceAgent ||
		!slices.Equal(got.People[0].Aliases, []string{"Annem"}) ||
		got.Settings.Version != version {
		t.Fatalf("incorrectly restored rows: %+v", got)
	}
}

func assertRestoreRetry(
	t *testing.T,
	svc *Service,
	req *protocol.RestoreRequest,
	result *protocol.RestoreResult,
) {
	t.Helper()

	req.Backup.Format = "invalid"
	req.ExpectedRevision = 0

	retry := restoreOK(t, svc, req)
	if !reflect.DeepEqual(retry, result) {
		t.Fatalf("restore retry = %+v, want %+v", retry, result)
	}
}

func assertReceiptsSurvive(
	t *testing.T, svc *Service, create *protocol.Operation, original *protocol.OpResult,
	restoreID, generation string,
) {
	t.Helper()

	oldRetry := apply(t, svc, item(create))[0]
	if !reflect.DeepEqual(oldRetry, *original) {
		t.Fatalf("operation receipt changed during restore: %+v", oldRetry)
	}

	receipts, err := svc.Receipts(
		t.Context(),
		&protocol.ReceiptsRequest{OpIDs: []string{create.ID, restoreID}},
	)
	if err != nil || len(receipts.Receipts) != 2 || receipts.Generation != generation ||
		receipts.Receipts[0].Generation != original.Generation || receipts.Receipts[0].Restore ||
		receipts.Receipts[1].OpID != restoreID || !receipts.Receipts[1].Restore {
		t.Fatalf("receipts after restore = %+v, error %v", receipts, err)
	}
}

func TestRestoreFailureLeavesLedgerIntact(t *testing.T) {
	t.Parallel()

	svc, db, generation := newLedger(t)
	create := createOp(generation, ledger.TypePerson, personID, personPayload)
	apply(t, svc, item(create))
	before := snapshot(t, svc)
	req := restoreRequest()
	req.ExpectedRevision = before.Revision
	req.Backup.TimeZone = "Local"

	invalid := restoreOK(t, svc, req)
	if invalid.Code == nil || *invalid.Code != ledger.CodeInvalid {
		t.Fatalf("invalid restore accepted: %+v", invalid)
	}

	req.Backup.TimeZone = "UTC"
	req.Backup.People = []ledger.Person{
		{
			ID: personID, Name: "Imported", Version: "", Payday: nil, Archived: false,
			Aliases: []string{},
		},
	}

	_, err := db.DB().ExecContext(t.Context(), `
		CREATE TRIGGER reject_test_restore BEFORE INSERT ON receipts
		BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`)
	if err != nil {
		t.Fatal(err)
	}

	_, err = svc.Restore(t.Context(), req)
	if err == nil || !reflect.DeepEqual(snapshot(t, svc), before) {
		t.Fatalf("failed restore changed the ledger, error %v", err)
	}

	receipts, err := svc.Receipts(t.Context(), &protocol.ReceiptsRequest{OpIDs: []string{req.OpID}})
	if err != nil || len(receipts.Receipts) != 0 {
		t.Fatalf("failed restore receipt stored: %+v, error %v", receipts, err)
	}

	_, err = db.DB().ExecContext(t.Context(), "DROP TRIGGER reject_test_restore")
	if err != nil {
		t.Fatal(err)
	}

	result := restoreOK(t, svc, req)

	after := snapshot(t, svc)
	person := req.Backup.People[0]
	person.Version = req.OpID

	if result.Status != protocol.StatusApplied ||
		!reflect.DeepEqual(after.People, []ledger.Person{person}) {
		t.Fatalf("restore retry = %+v, snapshot = %+v", result, after)
	}
}

func restoreRequest() *protocol.RestoreRequest {
	req := new(protocol.RestoreRequest)
	req.OpID = uuid.NewString()
	req.Backup.Format = protocol.BackupFormat
	req.Backup.FormatVersion = protocol.BackupFormatVersion
	req.Backup.Currency = ledger.CurrencyTRY
	req.Backup.TimeZone = "UTC"
	req.Backup.ExportedAt = "2026-01-01T00:00:00Z"
	req.Backup.People = []ledger.Person{}
	req.Backup.Purchases = []ledger.Purchase{}
	req.Backup.Payments = []ledger.Payment{}
	req.Backup.Refunds = []ledger.Refund{}
	req.Backup.Payouts = []ledger.Payout{}
	req.Backup.Unapplied = []protocol.UnappliedOperation{}

	return req
}

func TestRestoreRejectsMalformedUnappliedOps(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	apply(t, svc, item(createOp(generation, ledger.TypePerson, personID, personPayload)))
	before := snapshot(t, svc)
	req := restoreRequest()
	req.ExpectedRevision = before.Revision
	op := newOperation(generation, ledger.TypePayment, uuid.NewString(), ledger.KindUpdate)
	op.BaseVersion = new(uuid.NewString())
	op.Patch = json.RawMessage(`{"paidOn":123}`)
	req.Backup.Unapplied = []protocol.UnappliedOperation{
		{Op: *op, Dependencies: []string{}, Order: 0, Reason: nil},
	}

	result := restoreOK(t, svc, req)
	if result.Status != protocol.StatusRejected || result.Code == nil ||
		*result.Code != ledger.CodeInvalid || result.Reason == nil {
		t.Fatalf("malformed unapplied operation accepted: %+v", result)
	}

	if got := snapshot(t, svc); !reflect.DeepEqual(got, before) {
		t.Fatalf("malformed unapplied operation changed the ledger: %+v", got)
	}

	req.Backup.Unapplied[0].Op.Patch = json.RawMessage(`{"paidOn":"2025-01-01","note":null}`)
	req.Backup.Unapplied[0].Dependencies = []string{op.ID}

	result = restoreOK(t, svc, req)
	if result.Status != protocol.StatusRejected || result.Code == nil ||
		*result.Code != ledger.CodeInvalid {
		t.Fatalf("self-referencing unapplied dependency accepted: %+v", result)
	}

	req.Backup.Unapplied[0].Dependencies = []string{}
	if result = restoreOK(t, svc, req); result.Status != protocol.StatusApplied {
		t.Fatalf("valid held patch against an absent payment rejected: %+v", result)
	}
}

func TestRestoreRejectsBackupWithMissingCollections(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	apply(t, svc, item(createOp(generation, ledger.TypePerson, personID, personPayload)))
	before := snapshot(t, svc)

	full := restoreRequest()
	full.ExpectedRevision = before.Revision

	body, err := json.Marshal(full)
	if err != nil {
		t.Fatal(err)
	}

	for _, field := range []string{
		"exportedAt", "people", "purchases", "payments", "refunds", "payouts", "unapplied",
	} {
		var decoded map[string]any

		err = json.Unmarshal(body, &decoded)
		if err != nil {
			t.Fatal(err)
		}

		backup, ok := decoded["backup"].(map[string]any)
		if !ok {
			t.Fatal("backup is not an object")
		}

		delete(backup, field)

		partial, marshalErr := json.Marshal(decoded)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}

		req := new(protocol.RestoreRequest)

		err = json.Unmarshal(partial, req)
		if err != nil {
			t.Fatal(err)
		}

		result := restoreOK(t, svc, req)
		if result.Status != protocol.StatusRejected || result.Code == nil ||
			*result.Code != ledger.CodeInvalid {
			t.Fatalf("backup without %s accepted: %+v", field, result)
		}

		if got := snapshot(t, svc); !reflect.DeepEqual(got, before) {
			t.Fatalf("backup without %s changed the ledger: %+v", field, got)
		}
	}
}

func restoreOK(t *testing.T, svc *Service, req *protocol.RestoreRequest) *protocol.RestoreResult {
	t.Helper()

	result, err := svc.Restore(t.Context(), req)
	if err != nil {
		t.Fatal(err)
	}

	return result
}

func TestRestoreRejectsMalformedUnappliedWireFields(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name, payload string
	}{
		{"create with null base version", `"kind":"create","record":` + personPayload + `,"baseVersion":null`},
		{"create with null alias", `"kind":"create","record":` +
			strings.Replace(personPayload, `"aliases":[]`, `"aliases":[null]`, 1)},
		{"update with null alias", `"kind":"update","baseVersion":"previous","patch":{"aliases":[null]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			svc, _, generation := newLedger(t)
			apply(t, svc, item(createOp(generation, ledger.TypePerson, personID, personPayload)))
			before := snapshot(t, svc)
			req := restoreRequest()
			req.ExpectedRevision = before.Revision

			raw, err := json.Marshal(req.Backup)
			if err != nil {
				t.Fatal(err)
			}

			req.RawBackup = json.RawMessage(strings.Replace(string(raw), `"unapplied":[]`,
				`"unapplied":[{"order":0,"dependencies":[],"reason":null,"op":{`+
					`"id":"`+uuid.NewString()+`","generation":"`+generation+`",`+
					`"createdAt":"2025-11-22T12:00:00Z","recordType":"person","recordId":"`+personID+`",`+
					test.payload+`}}]`, 1))

			result := restoreOK(t, svc, req)
			if result.Status != protocol.StatusRejected || result.Code == nil ||
				*result.Code != ledger.CodeInvalid {
				t.Fatalf("malformed backup accepted: %+v", result)
			}

			if after := snapshot(t, svc); !reflect.DeepEqual(after, before) {
				t.Fatalf("malformed backup modified ledger: %+v", after)
			}
		})
	}
}
