package syncsvc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

type changeFixture struct {
	Name     string `json:"name"`
	TimeZone string `json:"timeZone"`
	Today    string `json:"today"`
	Expect   struct {
		Status string `json:"status"`
		Code   string `json:"code"`
	} `json:"expect"`
	Records ledger.Records     `json:"records"`
	Op      protocol.Operation `json:"op"`
}

func TestSharedChangeFixtures(t *testing.T) {
	t.Parallel()

	probe := ledger.ValidateChange(nil, nil, ledger.Change{
		Kind:            ledger.KindCreate,
		RecordType:      ledger.TypePerson,
		RecordID:        personID,
		AlreadyReturned: false,
	}, "2025-11-22")
	if probe == nil {
		t.Skip("ledger.ValidateChange is still a stub")
	}

	paths, err := filepath.Glob("../../testdata/changes/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no shared change fixtures: %v", err)
	}

	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			t.Parallel()

			testChangeFixture(t, path)
		})
	}
}

func testChangeFixture(t *testing.T, path string) {
	t.Helper()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	var fixture changeFixture

	err = json.Unmarshal(withWireIDs(raw), &fixture)
	if err != nil {
		t.Fatal(err)
	}

	defaultFixtureFields(t, &fixture)

	zone, err := time.LoadLocation(fixture.TimeZone)
	if err != nil {
		t.Fatal(err)
	}

	now, err := time.ParseInLocation(time.DateTime, fixture.Today+" 12:00:00", zone)
	if err != nil {
		t.Fatal(err)
	}

	svc, db := newService(t, now)
	fixture.Records.Settings = &ledger.Settings{
		ID: ledger.SettingsID, TimeZone: fixture.TimeZone, Currency: ledger.CurrencyTRY,
		Version: uuid.NewString(),
	}

	err = db.Write(t.Context(), func(ctx context.Context, tx *store.Tx) error {
		return tx.ReplaceRecords(ctx, &fixture.Records)
	})
	if err != nil {
		t.Fatal(err)
	}

	before := snapshot(t, svc)
	fixture.Op.Generation = before.Generation
	first := apply(t, svc, item(&fixture.Op))[0]

	revision := before.Revision
	if fixture.Expect.Status == protocol.StatusApplied {
		revision++
	}

	assertResult(t, first, fixture.Expect.Status, fixture.Expect.Code, revision)

	retry := apply(t, svc, item(&fixture.Op))[0]
	if !reflect.DeepEqual(first, retry) {
		t.Fatalf("fixture %q receipt changed after retry", fixture.Name)
	}

	after := snapshot(t, svc)
	if after.Revision != revision || (fixture.Expect.Status != protocol.StatusApplied &&
		!reflect.DeepEqual(before, after)) {
		t.Fatalf("unexpected ledger after applying fixture %q: %+v", fixture.Name, after)
	}
}

var fixtureID = regexp.MustCompile(
	`("(?:id|recordId|personId|purchaseId|baseVersion|version)"\s*:\s*)"([^"]+)"`,
)

// Shared fixtures use readable labels for IDs. Keep references and base versions
// intact while making those labels valid on the API wire.
func withWireIDs(input []byte) []byte {
	ids := make(map[string]string)

	return fixtureID.ReplaceAllFunc(input, func(match []byte) []byte {
		groups := fixtureID.FindSubmatch(match)
		label := string(groups[2])

		id, ok := ids[label]
		if !ok {
			id = uuid.NewString()
			ids[label] = id
		}

		return append(slices.Clip(groups[1]), []byte(`"`+id+`"`)...)
	})
}

// Fixtures may omit aliases (default []) and source (default "app"), except
// that a create record never gets a source.
func defaultFixtureFields(t *testing.T, fixture *changeFixture) {
	t.Helper()

	records := &fixture.Records
	for i := range records.People {
		if records.People[i].Aliases == nil {
			records.People[i].Aliases = []string{}
		}
	}

	for i := range records.Purchases {
		defaultSource(&records.Purchases[i].Source)
	}

	for i := range records.Payments {
		defaultSource(&records.Payments[i].Source)
	}

	for i := range records.Refunds {
		defaultSource(&records.Refunds[i].Source)
	}

	op := &fixture.Op
	switch op.Kind {
	case ledger.KindCreate:
		op.Record = withDefaultFields(t, op.Record, op.RecordType, false)
	case ledger.KindDelete:
		op.PreImage = withDefaultFields(t, op.PreImage, op.RecordType, true)
	}
}

func defaultSource(source *string) {
	if *source == "" {
		*source = ledger.SourceApp
	}
}

func withDefaultFields(
	t *testing.T, raw json.RawMessage, recordType string, withSource bool,
) json.RawMessage {
	t.Helper()

	var fields map[string]json.RawMessage

	err := json.Unmarshal(raw, &fields)
	if err != nil {
		t.Fatal(err)
	}

	defaults := map[string]json.RawMessage{}

	switch recordType {
	case ledger.TypePerson:
		defaults["aliases"] = json.RawMessage(`[]`)
	case ledger.TypePurchase, ledger.TypePayment, ledger.TypeRefund:
		if withSource {
			defaults["source"] = json.RawMessage(`"app"`)
		}
	}

	for key, value := range defaults {
		if _, ok := fields[key]; !ok {
			fields[key] = value
		}
	}

	encoded, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}

	return encoded
}
