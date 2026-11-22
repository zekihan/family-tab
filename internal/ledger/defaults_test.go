package ledger

import (
	"reflect"
	"strconv"
	"testing"
)

type defaultsFixture struct {
	Payday           *int             `json:"payday"`
	Today            string           `json:"today"`
	Shortcuts        DueShortcutDates `json:"shortcuts"`
	InstallmentStart InstallmentStart `json:"installmentStart"`
}

func TestDefaultsFixtures(t *testing.T) {
	t.Parallel()

	var fixtures []defaultsFixture
	readFixture(t, "defaults.json", &fixtures)

	if len(fixtures) < 15 {
		t.Fatalf("got %d defaults fixtures, want at least 15", len(fixtures))
	}

	for _, fixture := range fixtures {
		name := fixture.Today + " payday "
		if fixture.Payday == nil {
			name += "null"
		} else {
			name += strconv.Itoa(*fixture.Payday)
		}

		t.Run(name, func(t *testing.T) {
			t.Parallel()

			shortcuts := DueShortcuts(fixture.Today, fixture.Payday)
			if !reflect.DeepEqual(shortcuts, fixture.Shortcuts) {
				t.Errorf(
					"shortcuts = %s, want %s",
					fixtureJSON(t, shortcuts),
					fixtureJSON(t, fixture.Shortcuts),
				)
			}

			start := DefaultInstallmentStart(fixture.Today, fixture.Payday)
			if start != fixture.InstallmentStart {
				t.Errorf("installment start = %v, want %v", start, fixture.InstallmentStart)
			}

			if fixture.Payday != nil {
				got := FirstPaydayOnOrAfter(fixture.Today, *fixture.Payday)
				if got != *shortcuts.Payday {
					t.Errorf("first payday = %s, want %s", got, *shortcuts.Payday)
				}
			}
		})
	}
}
