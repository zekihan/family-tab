package ledger

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path"
	"reflect"
	"strconv"
	"testing"
)

const fixtureRoot = "../../testdata"

type ledgerFixture struct {
	Expect struct {
		Schedules map[string][]ScheduledAmount          `json:"schedules"`
		People    map[string]map[string]json.RawMessage `json:"people"`
		Valid     json.RawMessage                       `json:"valid"`
	} `json:"expect"`
	TimeZone string  `json:"timeZone"`
	Today    string  `json:"today"`
	Records  Records `json:"records"`
}

type fixtureOperation struct {
	Kind            string          `json:"kind"`
	RecordType      string          `json:"recordType"`
	RecordID        string          `json:"recordId"`
	Record          json.RawMessage `json:"record"`
	Patch           json.RawMessage `json:"patch"`
	AlreadyReturned bool            `json:"alreadyReturned"`
}

type changeFixture struct {
	Expect struct {
		Status string `json:"status"`
		Code   string `json:"code"`
	} `json:"expect"`
	TimeZone string           `json:"timeZone"`
	Today    string           `json:"today"`
	Records  Records          `json:"records"`
	Op       fixtureOperation `json:"op"`
}

type amountFixture struct {
	Minor *int64 `json:"minor"`
	Input string `json:"input"`
}

func TestAmountFixtures(t *testing.T) {
	t.Parallel()

	var fixtures []amountFixture
	readFixture(t, "amounts.json", &fixtures)

	for _, fixture := range fixtures {
		t.Run(strconv.Quote(fixture.Input), func(t *testing.T) {
			t.Parallel()

			got, err := ParseAmount(fixture.Input)
			if fixture.Minor == nil {
				if err == nil {
					t.Fatalf("got %d, want rejected", got)
				}

				return
			}

			if err != nil || got != *fixture.Minor {
				t.Fatalf("got %d, %v, want %d", got, err, *fixture.Minor)
			}
		})
	}
}

func TestLedgerFixtures(t *testing.T) {
	t.Parallel()

	runFixtures(t, "ledger/*.json", func(t *testing.T, fixture ledgerFixture) {
		t.Helper()

		records := &fixture.Records

		records.Settings = &Settings{
			ID:       SettingsID,
			Currency: CurrencyTRY,
			TimeZone: fixture.TimeZone, Version: "",
		}
		if len(fixture.Expect.Valid) > 0 {
			var want struct {
				Code string `json:"code"`
			}
			if !bytes.Equal(fixture.Expect.Valid, []byte("true")) {
				err := json.Unmarshal(fixture.Expect.Valid, &want)
				if err != nil {
					t.Fatal(err)
				}
			}

			assertRule(t, ValidateRecords(records, fixture.Today), want.Code)
		}

		assertSchedules(t, records, fixture.Expect.Schedules)
		assertFixtureBalances(t, records, fixture.Expect.People)
	})
}

func assertSchedules(t *testing.T, records *Records, expected map[string][]ScheduledAmount) {
	t.Helper()

	for id, want := range expected {
		var purchase *Purchase

		for i := range records.Purchases {
			if records.Purchases[i].ID == id {
				purchase = &records.Purchases[i]

				break
			}
		}

		got, err := AdjustedSchedule(purchase, records.Refunds)
		if err != nil {
			t.Fatalf("%s: adjusted schedule: %v", id, err)
		}

		if !reflect.DeepEqual(got, want) {
			t.Errorf(
				"%s: adjusted schedule = %s, want %s",
				id,
				fixtureJSON(t, got),
				fixtureJSON(t, want),
			)
		}

		base, err := BuildSchedule(purchase)
		if err != nil {
			t.Fatalf("%s: base schedule: %v", id, err)
		}

		for i := range want {
			want[i].AdjustedMinor = want[i].BaseMinor
		}

		if !reflect.DeepEqual(base, want) {
			t.Errorf(
				"%s: base schedule = %s, want %s",
				id,
				fixtureJSON(t, base),
				fixtureJSON(t, want),
			)
		}
	}
}

func assertFixtureBalances(
	t *testing.T, records *Records, expected map[string]map[string]json.RawMessage,
) {
	t.Helper()

	balances := Balances(records)
	for id, fields := range expected {
		balance, ok := balances[id]
		if !ok {
			t.Fatalf("balance missing for %s", id)
		}

		values := map[string]int64{
			"paymentsReceived": balance.PaymentsReceived,
			"cashReturned":     balance.CashReturned,
			"netReceipts":      balance.NetReceipts,
			"credit":           balance.Credit,
			"cashShortfall":    balance.CashShortfall,
		}
		for field, got := range values {
			if raw, ok := fields[field]; ok {
				var want int64

				err := json.Unmarshal(raw, &want)
				if err != nil {
					t.Fatal(err)
				}

				if got != want {
					t.Errorf("%s %s = %d, want %d", id, field, got, want)
				}
			}
		}
	}
}

func TestChangeFixtures(t *testing.T) {
	t.Parallel()

	runFixtures(t, "changes/*.json", func(t *testing.T, fixture changeFixture) {
		t.Helper()

		before := &fixture.Records
		before.Settings = &Settings{
			ID:       SettingsID,
			Currency: CurrencyTRY,
			TimeZone: fixture.TimeZone, Version: "",
		}
		op := &fixture.Op
		change := Change{
			Kind: op.Kind, RecordType: op.RecordType, RecordID: op.RecordID,
			AlreadyReturned: op.AlreadyReturned,
		}
		after := applyFixtureOperation(t, before, op)

		switch fixture.Expect.Status {
		case "applied":
			assertRule(t, ValidateChange(before, &after, change, fixture.Today), "")
		case "rejected":
			assertRule(
				t,
				ValidateChange(before, &after, change, fixture.Today),
				fixture.Expect.Code,
			)
		default:
			t.Fatalf("unknown expected status %q", fixture.Expect.Status)
		}
	})
}

func applyFixtureOperation(t *testing.T, before *Records, op *fixtureOperation) Records {
	t.Helper()

	after := *before

	switch op.RecordType {
	case TypePerson:
		after.People = applyFixture(t, before.People, op, func(row Person) string { return row.ID })
	case TypePurchase:
		after.Purchases = applyFixture(
			t,
			before.Purchases,
			op,
			func(row Purchase) string { return row.ID },
		)
	case TypePayment:
		after.Payments = applyFixture(
			t,
			before.Payments,
			op,
			func(row Payment) string { return row.ID },
		)
	case TypeRefund:
		after.Refunds = applyFixture(
			t,
			before.Refunds,
			op,
			func(row Refund) string { return row.ID },
		)
	case TypePayout:
		after.Payouts = applyFixture(
			t,
			before.Payouts,
			op,
			func(row Payout) string { return row.ID },
		)
	case TypeSettings:
		var rows []Settings
		if before.Settings != nil {
			rows = []Settings{*before.Settings}
		}

		rows = applyFixture(t, rows, op, func(row Settings) string { return row.ID })

		after.Settings = nil
		if len(rows) > 0 {
			after.Settings = &rows[len(rows)-1]
		}
	default:
		t.Fatalf("unknown record type %q", op.RecordType)
	}

	return after
}

func applyFixture[Row any](
	t *testing.T, before []Row, op *fixtureOperation, id func(Row) string,
) []Row {
	t.Helper()

	after := make([]Row, 0, len(before)+1)
	for _, row := range before {
		if id(row) == op.RecordID {
			switch op.Kind {
			case KindDelete:
				continue
			case KindUpdate:
				// Decode into a fresh row so pointer fields in before stay unchanged.
				original := fixtureJSON(t, row)

				var updated Row
				decodeFixture(t, original, &updated)
				decodeFixture(t, op.Patch, &updated)
				row = updated
			}
		}

		after = append(after, row)
	}

	if op.Kind == KindCreate {
		var row Row
		decodeFixture(t, op.Record, &row)
		after = append(after, row)
	}

	return after
}

func runFixtures[T any](t *testing.T, pattern string, check func(*testing.T, T)) {
	t.Helper()

	paths, err := fs.Glob(os.DirFS(fixtureRoot), pattern)
	if err != nil || len(paths) == 0 {
		t.Fatalf("fixtures matching %s: %v", pattern, err)
	}

	for _, file := range paths {
		t.Run(path.Base(file), func(t *testing.T) {
			t.Parallel()

			var fixture T
			readFixture(t, file, &fixture)
			check(t, fixture)
		})
	}
}

func readFixture(t *testing.T, file string, dest any) {
	t.Helper()

	data, err := fs.ReadFile(os.DirFS(fixtureRoot), file)
	if err != nil {
		t.Fatal(err)
	}

	decodeFixture(t, data, dest)
}

func decodeFixture(t *testing.T, data []byte, dest any) {
	t.Helper()

	err := json.Unmarshal(data, dest)
	if err != nil {
		t.Fatal(err)
	}
}

func fixtureJSON(t *testing.T, value any) []byte {
	t.Helper()

	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}

	return data
}

func assertRule(t *testing.T, got *RuleError, want string, blocking ...string) {
	t.Helper()

	if want == "" {
		if got != nil {
			t.Fatalf("got %v, want no error", got)
		}

		return
	}

	if got == nil || got.Code != want || got.Reason == "" {
		t.Fatalf("got %v, want %s with a reason", got, want)
	}

	if blocking != nil && !reflect.DeepEqual(got.Blocking, blocking) {
		t.Fatalf("blocking IDs = %v, want %v", got.Blocking, blocking)
	}
}
