package ledger

import (
	"strconv"
	"testing"
)

func TestNameFixtures(t *testing.T) {
	t.Parallel()

	var fixtures []struct {
		Input      string `json:"input"`
		Normalized string `json:"normalized"`
	}
	readFixture(t, "names.json", &fixtures)

	for _, fixture := range fixtures {
		t.Run(strconv.Quote(fixture.Input), func(t *testing.T) {
			t.Parallel()

			got := NormalizeName(fixture.Input)
			if got != fixture.Normalized {
				t.Fatalf("NormalizeName(%q) = %q, want %q", fixture.Input, got, fixture.Normalized)
			}
		})
	}
}

func TestTrimName(t *testing.T) {
	t.Parallel()

	for input, want := range map[string]string{
		"  Anne  ":                          "Anne",
		"\u00A0Büyük\t\n  Anne\uFEFF":       "Büyük Anne",
		"İSMAİL":                            "İSMAİL",
		" \u3000 ":                          "",
		"Mehmet\u00A0\u2003\uFEFFAli\u0085": "Mehmet Ali",
	} {
		if got := TrimName(input); got != want {
			t.Errorf("TrimName(%q) = %q, want %q", input, got, want)
		}
	}
}
