package mcp

import "testing"

func TestFormatTRY(t *testing.T) {
	t.Parallel()

	tests := map[int64]string{
		0:                "0,00 TL",
		5:                "0,05 TL",
		100:              "1,00 TL",
		150:              "1,50 TL",
		99999:            "999,99 TL",
		100000:           "1.000,00 TL",
		129990:           "1.299,90 TL",
		500000:           "5.000,00 TL",
		123456789:        "1.234.567,89 TL",
		1_000_000_000_00: "1.000.000.000,00 TL",
		-150:             "-1,50 TL",
		-129990:          "-1.299,90 TL",
	}

	for minor, want := range tests {
		got := formatTRY(minor)
		if got != want {
			t.Errorf("formatTRY(%d) = %q, want %q", minor, got, want)
		}
	}
}
