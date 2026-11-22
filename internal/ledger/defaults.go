package ledger

const twoWeeksInDays = 14

// DueShortcutDates are the due dates offered when adding a one-time purchase.
// Payday is nil when the person has no payday.
type DueShortcutDates struct {
	Payday     *string `json:"payday"`
	EndOfMonth string  `json:"endOfMonth"`
	InTwoWeeks string  `json:"inTwoWeeks"`
}

// InstallmentStart is the default first due date and due day of an
// installment plan.
type InstallmentStart struct {
	FirstDue string `json:"firstDue"`
	DueDay   int    `json:"dueDay"`
}

// FirstPaydayOnOrAfter returns the first date on or after today that falls on
// the payday, clamped to the length of the month.
func FirstPaydayOnOrAfter(today string, payday int) string {
	date, _ := parseDate(today)

	thisMonth := date.monthOffset(0, payday).String()
	if thisMonth >= today {
		return thisMonth
	}

	return date.monthOffset(1, payday).String()
}

// DueShortcuts returns the due date shortcuts for a person with the given
// payday, as offered when adding a one-time purchase on today.
func DueShortcuts(today string, payday *int) DueShortcutDates {
	date, _ := parseDate(today)
	shortcuts := DueShortcutDates{
		Payday:     nil,
		EndOfMonth: date.monthOffset(0, date.daysInMonth()).String(),
		InTwoWeeks: date.addDays(twoWeeksInDays).String(),
	}

	if payday != nil {
		first := FirstPaydayOnOrAfter(today, *payday)
		shortcuts.Payday = &first
	}

	return shortcuts
}

// DefaultInstallmentStart returns the first due date and due day an
// installment plan starts with when added on today.
func DefaultInstallmentStart(today string, payday *int) InstallmentStart {
	date, _ := parseDate(today)
	if payday == nil {
		return InstallmentStart{
			FirstDue: date.monthOffset(1, date.day).String(),
			DueDay:   date.day,
		}
	}

	return InstallmentStart{FirstDue: FirstPaydayOnOrAfter(today, *payday), DueDay: *payday}
}

func (date civilDate) addDays(days int) civilDate {
	date.day += days

	for date.day > date.daysInMonth() {
		date.day -= date.daysInMonth()

		date.month++
		if date.month > monthsPerYear {
			date.month = 1
			date.year++
		}
	}

	for date.day < 1 {
		date.month--
		if date.month == 0 {
			date.month = monthsPerYear
			date.year--
		}

		date.day += date.daysInMonth()
	}

	return date
}
