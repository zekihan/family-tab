package syncsvc

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/protocol"
)

func FuzzApply(f *testing.F) {
	f.Add([]byte(`{"kind":"create","recordType":"person","recordId":"` +
		personID + `","record":` + personPayload + `}`))
	f.Add([]byte(`{"kind":"update","recordType":"person","recordId":"` +
		personID + `","baseVersion":"lost","patch":{"name":null}}`))
	f.Add([]byte(`{"kind":"create","recordType":"person","recordId":"` +
		personID + `","record":{"id":"` + personID + `","unknown":true}}`))
	f.Add([]byte(`null`))

	f.Fuzz(func(t *testing.T, input []byte) {
		var op protocol.Operation

		err := json.Unmarshal(input, &op)
		if err != nil {
			return
		}

		svc, _, generation := newLedger(t)
		op.Generation = generation

		if op.ID == "" {
			op.ID = uuid.NewString()
		}

		before := snapshot(t, svc)
		first := apply(t, svc, item(&op))[0]
		expected := before.Revision

		switch first.Status {
		case protocol.StatusApplied:
			expected++
		case protocol.StatusConflict, protocol.StatusRejected:
		default:
			t.Fatalf("unexpected operation status %q", first.Status)
		}

		second := apply(t, svc, item(&op))[0]
		if !reflect.DeepEqual(first, second) {
			t.Fatalf("receipt changed on retry: %+v to %+v", first, second)
		}

		if got := snapshot(t, svc).Revision; got != expected || first.Revision != expected {
			t.Fatalf("revision = %d, receipt revision = %d, want %d", got, first.Revision, expected)
		}
	})
}
