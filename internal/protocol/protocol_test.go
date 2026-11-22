package protocol

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestOpResultWireShapes(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		code   *string
		status string
		want   string
	}{
		{
			status: StatusApplied, code: nil,
			want: `{"opId":"op","status":"applied","code":null,` +
				`"reason":null,"blocking":[],"current":null,"generation":"gen","revision":0}`,
		},
		{
			status: StatusRejected, code: new("not_setup"),
			want: `{"opId":"op","status":"rejected","code":"not_setup",` +
				`"reason":null,"blocking":[],"current":null,"generation":"gen","revision":0}`,
		},
		{
			status: StatusHeld, code: new(CodeGenerationMismatch),
			want: `{"opId":"op","status":"held","code":"generation_mismatch","generation":"gen"}`,
		},
		{
			status: StatusSkipped, code: new(CodeDependencyNotApplied),
			want: `{"opId":"op","status":"skipped","code":"dependency_not_applied"}`,
		},
	} {
		t.Run(test.status, func(t *testing.T) {
			t.Parallel()

			result := OpResult(Receipt{
				OpID: "op", Status: test.status, Generation: "gen", Code: test.code,
				Reason: nil, Current: json.RawMessage("null"), Blocking: []string{}, Revision: 0,
			})

			got, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}

			var gotFields, wantFields map[string]any

			err = json.Unmarshal(got, &gotFields)
			if err != nil {
				t.Fatal(err)
			}

			err = json.Unmarshal([]byte(test.want), &wantFields)
			if err != nil {
				t.Fatal(err)
			}

			if !reflect.DeepEqual(gotFields, wantFields) {
				t.Fatalf("result JSON = %s, want %s", got, test.want)
			}
		})
	}
}
