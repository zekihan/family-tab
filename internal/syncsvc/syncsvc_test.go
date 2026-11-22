package syncsvc

import (
	"encoding/json"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

const (
	personID        = "d89f2479-ba78-4e22-9be9-27e9102585fe"
	personPayload   = `{"id":"` + personID + `","name":"Ada","payday":5,"archived":false,"aliases":[]}`
	settingsPayload = `{"id":"ledger","timeZone":"UTC","currency":"TRY"}`
)

func newService(t *testing.T, now time.Time) (*Service, *store.Store) {
	t.Helper()

	db, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = db.Close() })

	return New(db, func() time.Time { return now }), db
}

func newLedger(t *testing.T) (*Service, *store.Store, string) {
	t.Helper()

	svc, db := newService(t, time.Date(2025, time.November, 22, 12, 0, 0, 0, time.UTC))
	generation := snapshot(t, svc).Generation
	setup := createOp(generation, ledger.TypeSettings, ledger.SettingsID, settingsPayload)

	result := apply(t, svc, item(setup))[0]
	assertResult(t, result, protocol.StatusApplied, "", 1)

	return svc, db, generation
}

func createOp(generation, recordType, recordID, record string) *protocol.Operation {
	op := newOperation(generation, recordType, recordID, ledger.KindCreate)
	op.Record = json.RawMessage(record)

	return op
}

func newOperation(generation, recordType, recordID, kind string) *protocol.Operation {
	op := new(protocol.Operation)
	op.ID = uuid.NewString()
	op.Generation = generation
	op.RecordType = recordType
	op.RecordID = recordID
	op.Kind = kind
	op.CreatedAt = "2025-11-22T12:00:00Z"

	return op
}

func item(op *protocol.Operation, deps ...string) protocol.OpsItem {
	return protocol.OpsItem{Op: *op, Deps: deps}
}

func snapshot(t *testing.T, svc *Service) *protocol.Snapshot {
	t.Helper()

	got, err := svc.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	return got
}

func apply(t *testing.T, svc *Service, items ...protocol.OpsItem) []protocol.OpResult {
	t.Helper()

	response, err := svc.Apply(t.Context(), &protocol.OpsRequest{Items: items}, ledger.SourceApp)
	if err != nil {
		t.Fatal(err)
	}

	if len(response.Results) != len(items) {
		t.Fatalf("got %d results for %d items", len(response.Results), len(items))
	}

	return response.Results
}

//nolint:gocritic // Result values commonly come from expressions in test assertions.
func assertResult(t *testing.T, result protocol.OpResult, status, code string, revision int64) {
	t.Helper()

	gotCode := ""
	if result.Code != nil {
		gotCode = *result.Code
	}

	if result.Status != status || gotCode != code || result.Revision != revision {
		t.Fatalf("result = %s/%s at %d, want %s/%s at %d (%+v)",
			result.Status, gotCode, result.Revision, status, code, revision, result)
	}
}

func TestApplyReceiptsAndDependencies(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	create := createOp(generation, ledger.TypePerson, personID, personPayload)
	conflict := newOperation(generation, ledger.TypePerson, personID, ledger.KindUpdate)
	conflict.BaseVersion = new(uuid.NewString())
	conflict.Patch = json.RawMessage(`{"archived":true}`)
	skip := newOperation(generation, ledger.TypePerson, personID, ledger.KindUpdate)
	held := newOperation(uuid.NewString(), ledger.TypePerson, personID, ledger.KindUpdate)
	patch := newOperation(generation, ledger.TypePerson, personID, ledger.KindUpdate)
	patch.BaseVersion = &create.ID
	patch.Patch = json.RawMessage(`{"payday":null,"name":"Ada L."}`)

	results := apply(t, svc, item(create), item(conflict), item(skip, conflict.ID), item(held),
		item(patch, create.ID))
	assertResult(t, results[0], protocol.StatusApplied, "", 2)
	assertResult(t, results[1], protocol.StatusConflict, ledger.CodeConflict, 2)
	assertResult(t, results[2], protocol.StatusSkipped, protocol.CodeDependencyNotApplied, 0)
	assertResult(t, results[3], protocol.StatusHeld, protocol.CodeGenerationMismatch, 0)
	assertResult(t, results[4], protocol.StatusApplied, "", 3)

	var current ledger.Person

	err := json.Unmarshal(results[1].Current, &current)
	if err != nil || current.ID != personID || current.Version != create.ID {
		t.Fatalf("current record is %s: %v", results[1].Current, err)
	}

	got := snapshot(t, svc)
	if len(got.People) != 1 || got.People[0].Name != "Ada L." ||
		got.People[0].Payday != nil || got.People[0].Version != patch.ID {
		t.Fatalf("patched people = %+v", got.People)
	}

	conflict.Generation = held.Generation

	retry := apply(t, svc, item(conflict, skip.ID))[0]
	if !reflect.DeepEqual(retry, results[1]) {
		t.Fatalf("receipt changed on retry: %+v, originally %+v", retry, results[1])
	}

	receipts, err := svc.Receipts(t.Context(), &protocol.ReceiptsRequest{
		OpIDs: []string{held.ID, conflict.ID, skip.ID, create.ID},
	})
	if err != nil || len(receipts.Receipts) != 2 || receipts.Generation != generation ||
		!reflect.DeepEqual(receipts.Receipts[0], protocol.Receipt(results[1])) ||
		!reflect.DeepEqual(receipts.Receipts[1], protocol.Receipt(results[0])) {
		t.Fatalf("receipts = %+v, error %v", receipts, err)
	}
}

func TestConflictAfterDelete(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	create := createOp(generation, ledger.TypePerson, personID, personPayload)
	apply(t, svc, item(create))

	remove := newOperation(generation, ledger.TypePerson, personID, ledger.KindDelete)
	remove.BaseVersion = &create.ID

	person := snapshot(t, svc).People[0]

	preImage, err := json.Marshal(person)
	if err != nil {
		t.Fatal(err)
	}

	remove.PreImage = preImage
	results := apply(t, svc, item(remove, create.ID))
	assertResult(t, results[0], protocol.StatusApplied, "", 3)

	stale := newOperation(generation, ledger.TypePerson, personID, ledger.KindUpdate)
	stale.BaseVersion = &create.ID
	stale.Patch = json.RawMessage(`{"archived":true}`)
	conflict := apply(t, svc, item(stale))[0]
	assertResult(t, conflict, protocol.StatusConflict, ledger.CodeConflict, 3)

	if string(conflict.Current) != "null" {
		t.Fatalf("deleted record conflict current = %q", conflict.Current)
	}
}

func TestStrictOperations(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	create := createOp(generation, ledger.TypePerson, personID, personPayload)
	apply(t, svc, item(create))

	patches := []string{
		`{"unknown":1}`, `{"Name":"Ada"}`, `{"name":"Ada","name":"Grace"}`,
		`{"id":"` + personID + `"}`, `{"version":"v"}`, `{"archived":null}`,
		`{"archived":"false"}`, `{"payday":2.5}`, `null`, `[]`, `{"name":"Ada"} {}`,
	}
	for _, payload := range patches {
		update := newOperation(generation, ledger.TypePerson, personID, ledger.KindUpdate)
		update.BaseVersion = &create.ID
		update.Patch = json.RawMessage(payload)
		result := apply(t, svc, item(update))[0]
		assertResult(t, result, protocol.StatusRejected, ledger.CodeInvalid, 2)
	}

	settings := snapshot(t, svc).Settings
	updateSettings := newOperation(
		generation,
		ledger.TypeSettings,
		ledger.SettingsID,
		ledger.KindUpdate,
	)
	updateSettings.BaseVersion = &settings.Version
	updateSettings.Patch = json.RawMessage(`{"currency":"TRY"}`)
	assertResult(
		t,
		apply(t, svc, item(updateSettings))[0],
		protocol.StatusRejected,
		ledger.CodeInvalid,
		2,
	)

	purchase := createOp(generation, ledger.TypePurchase, personID, `{}`)
	assertResult(
		t,
		apply(t, svc, item(purchase))[0],
		protocol.StatusRejected,
		ledger.CodeDuplicateID,
		2,
	)

	badCreate := createOp(generation, ledger.TypePerson, uuid.NewString(), personPayload)
	assertResult(
		t,
		apply(t, svc, item(badCreate))[0],
		protocol.StatusRejected,
		ledger.CodeInvalid,
		2,
	)
}

func TestApplyConcurrent(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)

	const count = 20

	var group sync.WaitGroup

	revisions := make(chan int64, count)

	for range count {
		group.Go(func() {
			id := uuid.NewString()
			op := createOp(generation, ledger.TypePerson, id,
				`{"id":"`+id+`","name":"Ada","payday":null,"archived":false,"aliases":[]}`)

			response, err := svc.Apply(
				t.Context(),
				&protocol.OpsRequest{Items: []protocol.OpsItem{item(op)}},
				ledger.SourceApp,
			)
			if err != nil || response.Results[0].Status != protocol.StatusApplied {
				t.Errorf("concurrent apply = %+v, error %v", response, err)

				return
			}

			revisions <- response.Results[0].Revision
		})
	}

	group.Wait()
	close(revisions)

	seen := make(map[int64]bool)
	for revision := range revisions {
		if seen[revision] {
			t.Errorf("repeated revision %d", revision)
		}

		seen[revision] = true
	}

	got := snapshot(t, svc)
	if got.Revision != count+1 || len(got.People) != count || len(seen) != count {
		t.Fatalf(
			"revision %d, %d people, %d distinct revisions",
			got.Revision,
			len(got.People),
			len(seen),
		)
	}
}

func TestApplyStampsSource(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	apply(t, svc, item(createOp(generation, ledger.TypePerson, personID, personPayload)))

	paymentID := uuid.NewString()
	payment := `{"id":"` + paymentID + `","personId":"` + personID +
		`","amountMinor":500,"paidOn":"2025-11-01","note":null}`
	withSource := createOp(generation, ledger.TypePayment, paymentID,
		payment[:len(payment)-1]+`,"source":"agent"}`)
	assertResult(t, apply(t, svc, item(withSource))[0],
		protocol.StatusRejected, ledger.CodeInvalid, 2)

	create := createOp(generation, ledger.TypePayment, paymentID, payment)

	response, err := svc.Apply(
		t.Context(), &protocol.OpsRequest{Items: []protocol.OpsItem{item(create)}},
		ledger.SourceAgent,
	)
	if err != nil {
		t.Fatal(err)
	}

	assertResult(t, response.Results[0], protocol.StatusApplied, "", 3)

	patch := newOperation(generation, ledger.TypePayment, paymentID, ledger.KindUpdate)
	patch.BaseVersion = &create.ID
	patch.Patch = json.RawMessage(`{"source":"app"}`)
	assertResult(t, apply(t, svc, item(patch))[0], protocol.StatusRejected, ledger.CodeInvalid, 3)

	edit := newOperation(generation, ledger.TypePayment, paymentID, ledger.KindUpdate)
	edit.BaseVersion = &create.ID
	edit.Patch = json.RawMessage(`{"amountMinor":400}`)
	assertResult(t, apply(t, svc, item(edit))[0], protocol.StatusApplied, "", 4)

	got := snapshot(t, svc)
	if len(got.Payments) != 1 || got.Payments[0].Source != ledger.SourceAgent ||
		got.Payments[0].AmountMinor != 400 {
		t.Fatalf("payments = %+v", got.Payments)
	}

	_, err = svc.Apply(t.Context(), &protocol.OpsRequest{Items: nil}, "")
	if err == nil {
		t.Fatal("Apply accepted an empty source")
	}
}

func TestApplyAliases(t *testing.T) {
	t.Parallel()

	svc, _, generation := newLedger(t)
	create := createOp(generation, ledger.TypePerson, personID, personPayload)
	apply(t, svc, item(create))

	otherID := uuid.NewString()
	other := createOp(generation, ledger.TypePerson, otherID, `{"id":"`+otherID+
		`","name":"Zeynep","payday":null,"archived":true,"aliases":["Ada'nın kızı"]}`)
	assertResult(t, apply(t, svc, item(other))[0], protocol.StatusApplied, "", 3)

	patch := newOperation(generation, ledger.TypePerson, personID, ledger.KindUpdate)
	patch.BaseVersion = &create.ID
	patch.Patch = json.RawMessage(`{"aliases":["ZEYNEP"]}`)

	result := apply(t, svc, item(patch))[0]
	assertResult(t, result, protocol.StatusRejected, ledger.CodeAliasConflict, 3)

	if !slices.Equal(result.Blocking, []string{otherID}) {
		t.Fatalf("blocking = %v, want [%s]", result.Blocking, otherID)
	}

	for _, invalid := range []string{`{"aliases":null}`, `{"aliases":"Ana"}`, `{"aliases":[1]}`} {
		bad := newOperation(generation, ledger.TypePerson, personID, ledger.KindUpdate)
		bad.BaseVersion = &create.ID
		bad.Patch = json.RawMessage(invalid)
		assertResult(t, apply(t, svc, item(bad))[0], protocol.StatusRejected, ledger.CodeInvalid, 3)
	}

	update := newOperation(generation, ledger.TypePerson, personID, ledger.KindUpdate)
	update.BaseVersion = &create.ID
	update.Patch = json.RawMessage(`{"aliases":["Anne","Annem"]}`)
	assertResult(t, apply(t, svc, item(update))[0], protocol.StatusApplied, "", 4)

	got := snapshot(t, svc).People
	if !slices.ContainsFunc(got, func(row ledger.Person) bool {
		return row.ID == personID && slices.Equal(row.Aliases, []string{"Anne", "Annem"})
	}) {
		t.Fatalf("people = %+v", got)
	}
}
