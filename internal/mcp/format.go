package mcp

import (
	"strconv"
	"strings"
)

const (
	minorPerMajor  = 100
	groupSize      = 3
	fractionDigits = 2
)

// formatTRY formats kuruş as a Turkish lira string such as "1.299,90 TL":
// dots group thousands and a comma starts exactly two decimals.
func formatTRY(minor int64) string {
	sign := ""
	magnitude := minor

	if minor < 0 {
		sign = "-"
		magnitude = -minor
	}

	whole := strconv.FormatInt(magnitude/minorPerMajor, 10)
	fraction := strconv.FormatInt(magnitude%minorPerMajor, 10)

	var grouped strings.Builder

	for index, digit := range whole {
		if index > 0 && (len(whole)-index)%groupSize == 0 {
			grouped.WriteByte('.')
		}

		grouped.WriteRune(digit)
	}

	if len(fraction) < fractionDigits {
		fraction = "0" + fraction
	}

	return sign + grouped.String() + "," + fraction + " TL"
}
