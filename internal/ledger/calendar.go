package ledger

const (
	daysPerEra   = 146097
	daysPerYear  = 365
	yearsPerEra  = 400
	epochShift   = 719468
	monthsInYear = 12
	marchStart   = 3
	februaryMax  = 2
	monthStep    = 153
	monthShift   = 2
	monthDivisor = 5
)

// ValidDate reports whether value is a real calendar date in YYYY-MM-DD form.
func ValidDate(value string) bool {
	_, ok := parseDate(value)

	return ok
}

// DayOfMonth returns the day of the month of a YYYY-MM-DD date.
func DayOfMonth(value string) (int, bool) {
	date, ok := parseDate(value)

	return date.day, ok
}

// IsLastDayOfMonth reports whether value is a valid date on the last day of
// its month.
func IsLastDayOfMonth(value string) bool {
	date, ok := parseDate(value)

	return ok && date.day == date.daysInMonth()
}

// DaysBetween returns the number of calendar days from one YYYY-MM-DD date to
// another, negative when to is earlier. The second result is false when
// either date is invalid.
func DaysBetween(from, to string) (int, bool) {
	start, startOK := parseDate(from)
	end, endOK := parseDate(to)

	if !startOK || !endOK {
		return 0, false
	}

	return end.dayNumber() - start.dayNumber(), true
}

// dayNumber counts days since 1970-01-01 in the proleptic Gregorian calendar.
func (date civilDate) dayNumber() int {
	year := date.year
	if date.month <= februaryMax {
		year--
	}

	era := year / yearsPerEra
	yearOfEra := year - era*yearsPerEra

	monthIndex := date.month - marchStart
	if date.month < marchStart {
		monthIndex += monthsInYear
	}

	dayOfYear := (monthStep*monthIndex+monthShift)/monthDivisor + date.day - 1
	dayOfEra := yearOfEra*daysPerYear + yearOfEra/4 - yearOfEra/100 + dayOfYear

	return era*daysPerEra + dayOfEra - epochShift
}
