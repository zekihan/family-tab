package ledger

import (
	"fmt"
	"strconv"
)

const (
	monthsPerYear    = 12
	lastCivilYear    = 9999
	leapFebruaryDays = 29
)

type civilDate struct {
	year, month, day int
}

func parseDate(value string) (civilDate, bool) {
	var zero civilDate
	if len(value) != 10 || value[4] != '-' || value[7] != '-' {
		return zero, false
	}

	for i := range len(value) {
		if i != 4 && i != 7 && (value[i] < '0' || value[i] > '9') {
			return zero, false
		}
	}

	year, yearErr := strconv.Atoi(value[:4])
	month, monthErr := strconv.Atoi(value[5:7])
	day, dayErr := strconv.Atoi(value[8:])
	date := civilDate{year: year, month: month, day: day}
	valid := yearErr == nil && monthErr == nil && dayErr == nil &&
		year > 0 && day > 0 && day <= date.daysInMonth()

	return date, valid
}

func (date civilDate) String() string {
	return fmt.Sprintf("%04d-%02d-%02d", date.year, date.month, date.day)
}

func (date civilDate) daysInMonth() int {
	days := [monthsPerYear]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if date.month < 1 || date.month > monthsPerYear {
		return 0
	}

	if date.month == 2 && (date.year%400 == 0 || date.year%4 == 0 && date.year%100 != 0) {
		return leapFebruaryDays
	}

	return days[date.month-1]
}

func (date civilDate) monthOffset(offset, anchorDay int) civilDate {
	month := date.month - 1 + offset
	result := civilDate{
		year:  date.year + month/monthsPerYear,
		month: month%monthsPerYear + 1,
		day:   0,
	}
	result.day = min(anchorDay, result.daysInMonth())

	return result
}
