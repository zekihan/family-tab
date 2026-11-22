package mcp

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	// IANA zones for the ledger time zone.
	_ "time/tzdata"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
	"github.com/zekihan/family-tab/internal/syncsvc"
)

type fakeClock struct {
	now time.Time
	mu  sync.Mutex
}

func (clock *fakeClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()

	return clock.now
}

func (clock *fakeClock) Advance(delta time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()

	clock.now = clock.now.Add(delta)
}

// harness is a real store and sync service behind the MCP handler, with an SDK
// client connected over streamable HTTP.
type harness struct {
	t       *testing.T
	svc     *syncsvc.Service
	clock   *fakeClock
	session *sdk.ClientSession
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	st, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	clock := &fakeClock{
		now: time.Date(2026, time.November, 22, 10, 0, 0, 0, time.UTC), mu: sync.Mutex{},
	}
	svc := syncsvc.New(st, clock.Now)

	httpServer := httptest.NewServer(NewHandler(Deps{Ledger: svc, Now: clock.Now, Version: "test"}))
	t.Cleanup(httpServer.Close)

	implementation := new(sdk.Implementation)
	implementation.Name = "test"
	implementation.Version = "1"

	transport := new(sdk.StreamableClientTransport)
	transport.Endpoint = httpServer.URL
	transport.DisableStandaloneSSE = true

	session, err := sdk.NewClient(implementation, nil).Connect(t.Context(), transport, nil)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = session.Close() })

	return &harness{t: t, svc: svc, clock: clock, session: session}
}

func (env *harness) snapshot() *protocol.Snapshot {
	env.t.Helper()

	snapshot, err := env.svc.Snapshot(env.t.Context())
	if err != nil {
		env.t.Fatal(err)
	}

	return snapshot
}

func (env *harness) newOperation(kind, recordType, recordID string) *protocol.Operation {
	return &protocol.Operation{
		BaseVersion: nil, ID: uuid.NewString(), Generation: env.snapshot().Generation,
		CreatedAt: env.clock.Now().UTC().Format(time.RFC3339), Kind: kind,
		RecordType: recordType, RecordID: recordID, Record: nil, Patch: nil, PreImage: nil,
		AlreadyReturned: false,
	}
}

// apply commits an operation as the app and fails the test unless it is applied.
func (env *harness) apply(op *protocol.Operation) {
	env.t.Helper()

	response, err := env.svc.Apply(env.t.Context(), &protocol.OpsRequest{
		Items: []protocol.OpsItem{{Deps: []string{}, Op: *op}},
	}, ledger.SourceApp)
	if err != nil {
		env.t.Fatal(err)
	}

	if response.Results[0].Status != protocol.StatusApplied {
		env.t.Fatalf(
			"operation %s %s was not applied: %+v",
			op.Kind,
			op.RecordType,
			response.Results[0],
		)
	}
}

func (env *harness) create(recordType, recordID string, record any) {
	env.t.Helper()

	raw, err := json.Marshal(record)
	if err != nil {
		env.t.Fatal(err)
	}

	op := env.newOperation(ledger.KindCreate, recordType, recordID)
	op.Record = raw
	env.apply(op)
}

func (env *harness) update(recordType, recordID, baseVersion string, patch any) {
	env.t.Helper()

	raw, err := json.Marshal(patch)
	if err != nil {
		env.t.Fatal(err)
	}

	op := env.newOperation(ledger.KindUpdate, recordType, recordID)
	op.BaseVersion = &baseVersion
	op.Patch = raw
	env.apply(op)
}

func (env *harness) setup() {
	env.t.Helper()

	env.create(ledger.TypeSettings, ledger.SettingsID, map[string]string{
		"id": ledger.SettingsID, "timeZone": "Europe/Istanbul", "currency": ledger.CurrencyTRY,
	})
}

func (env *harness) addPerson(name string, payday *int, aliases ...string) string {
	env.t.Helper()

	if aliases == nil {
		aliases = []string{}
	}

	id := uuid.NewString()
	env.create(ledger.TypePerson, id, map[string]any{
		"id": id, "name": name, "payday": payday, "aliases": aliases, "archived": false,
	})

	return id
}

// addAppPurchase creates a one-time purchase as the app. dueDate may be empty.
func (env *harness) addAppPurchase(
	personID, item string, totalMinor int64, boughtOn, dueDate string,
) string {
	env.t.Helper()

	var due any
	if dueDate != "" {
		due = dueDate
	}

	id := uuid.NewString()
	env.create(ledger.TypePurchase, id, map[string]any{
		"id": id, "personId": personID, "item": item, "totalMinor": totalMinor,
		"boughtOn": boughtOn, "plan": ledger.PlanOnce, "dueDate": due, "count": nil,
		"firstDue": nil, "dueDay": nil, "note": nil,
	})

	return id
}

func (env *harness) addAppPayment(personID string, amountMinor int64, paidOn string) string {
	env.t.Helper()

	id := uuid.NewString()
	env.create(ledger.TypePayment, id, map[string]any{
		"id": id, "personId": personID, "amountMinor": amountMinor, "paidOn": paidOn, "note": nil,
	})

	return id
}

func (env *harness) purchase(id string) *ledger.Purchase {
	env.t.Helper()

	snapshot := env.snapshot()
	for index := range snapshot.Purchases {
		if snapshot.Purchases[index].ID == id {
			return &snapshot.Purchases[index]
		}
	}

	env.t.Fatalf("purchase %s not found", id)

	return nil
}

// call runs a tool. On a tool error it returns the error text and a nil result.
func (env *harness) call(name string, arguments map[string]any) (map[string]any, string) {
	env.t.Helper()

	params := new(sdk.CallToolParams)
	params.Name = name
	params.Arguments = arguments

	result, err := env.session.CallTool(context.WithoutCancel(env.t.Context()), params)
	if err != nil {
		env.t.Fatalf("%s: %v", name, err)
	}

	if result.IsError {
		var message strings.Builder

		for _, content := range result.Content {
			if part, ok := content.(*sdk.TextContent); ok {
				message.WriteString(part.Text)
			}
		}

		return nil, message.String()
	}

	raw, err := json.Marshal(result.StructuredContent)
	if err != nil {
		env.t.Fatal(err)
	}

	var decoded map[string]any

	err = json.Unmarshal(raw, &decoded)
	if err != nil {
		env.t.Fatal(err)
	}

	return decoded, ""
}

func (env *harness) mustCall(name string, arguments map[string]any) map[string]any {
	env.t.Helper()

	result, failure := env.call(name, arguments)
	if failure != "" {
		env.t.Fatalf("%s failed: %s", name, failure)
	}

	return result
}

func (env *harness) mustFail(name string, arguments map[string]any, wants ...string) string {
	env.t.Helper()

	result, failure := env.call(name, arguments)
	if failure == "" {
		env.t.Fatalf("%s succeeded with %v, want an error", name, result)
	}

	for _, want := range wants {
		if !strings.Contains(failure, want) {
			env.t.Fatalf("%s error %q does not contain %q", name, failure, want)
		}
	}

	return failure
}

// field walks a decoded result by object keys and slice indexes ("0", "1").
func field(t *testing.T, value any, path ...string) any {
	t.Helper()

	for _, key := range path {
		switch typed := value.(type) {
		case map[string]any:
			next, ok := typed[key]
			if !ok {
				t.Fatalf("no field %q in %v", key, typed)
			}

			value = next
		case []any:
			index, err := strconv.Atoi(key)
			if err != nil || index < 0 || index >= len(typed) {
				t.Fatalf("bad index %q for %v", key, typed)
			}

			value = typed[index]
		default:
			t.Fatalf("cannot read %q in %v", key, value)
		}
	}

	return value
}

func normalize(value any) any {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int:
		return int64(typed)
	default:
		return value
	}
}

// expect checks scalar fields of a decoded result, addressed by dotted paths
// such as "purchase.totalMinor" or "people.0.name". Numbers compare as integers.
func expect(t *testing.T, value any, want map[string]any) {
	t.Helper()

	for path, expected := range want {
		got := field(t, value, strings.Split(path, ".")...)
		if normalize(got) != normalize(expected) {
			t.Errorf("%s = %v, want %v", path, got, expected)
		}
	}
}

func text(t *testing.T, value any, path ...string) string {
	t.Helper()

	got, ok := field(t, value, path...).(string)
	if !ok {
		t.Fatalf("%v is not a string", path)
	}

	return got
}

func count(t *testing.T, value any, path ...string) int {
	t.Helper()

	got, ok := field(t, value, path...).([]any)
	if !ok {
		t.Fatalf("%v is not a list", path)
	}

	return len(got)
}
