package ledger

import "testing"

func TestDaysBetween(t *testing.T) {
	t.Parallel()

	tests := []struct {
		from, to string
		days     int
		ok       bool
	}{
		{"2026-03-10", "2026-03-10", 0, true},
		{"2026-03-10", "2026-03-13", 3, true},
		{"2026-03-13", "2026-03-10", -3, true},
		{"2026-02-27", "2026-03-02", 3, true},
		{"2028-02-27", "2028-03-02", 4, true},
		{"2025-12-30", "2026-01-02", 3, true},
		{"1970-01-01", "1970-01-02", 1, true},
		{"1969-12-31", "1970-01-01", 1, true},
		{"2000-01-01", "2026-11-22", 9822, true},
		{"2026-02-30", "2026-03-01", 0, false},
		{"2026-03-01", "tomorrow", 0, false},
	}

	for _, test := range tests {
		days, ok := DaysBetween(test.from, test.to)
		if days != test.days || ok != test.ok {
			t.Errorf("DaysBetween(%q, %q) = %d, %v; want %d, %v",
				test.from, test.to, days, ok, test.days, test.ok)
		}
	}
}

func TestDateHelpers(t *testing.T) {
	t.Parallel()

	if !ValidDate("2028-02-29") || ValidDate("2026-02-29") || ValidDate("2026-2-9") {
		t.Error("ValidDate accepted or rejected a wrong date")
	}

	if !IsLastDayOfMonth("2026-02-28") || IsLastDayOfMonth("2028-02-28") ||
		!IsLastDayOfMonth("2026-04-30") || IsLastDayOfMonth("nope") {
		t.Error("IsLastDayOfMonth is wrong")
	}

	if day, ok := DayOfMonth("2026-04-17"); day != 17 || !ok {
		t.Errorf("DayOfMonth = %d, %v", day, ok)
	}
}
