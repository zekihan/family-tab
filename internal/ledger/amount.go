package ledger

import (
	"errors"
	"strconv"
	"strings"
)

const (
	minorPerMajor  = 100
	fractionDigits = 2
	groupDigits    = 3
	maxAmount      = int64(10_000_000_000)
)

var errAmount = errors.New("invalid amount")

func parseAmount(input string) (int64, error) {
	input = strings.TrimSpace(input)
	for _, char := range input {
		if (char < '0' || char > '9') && char != '.' && char != ',' {
			return 0, errAmount
		}
	}

	decimal, grouping := amountSeparators(input)

	whole, fraction, err := splitAmount(input, decimal, grouping)
	if err != nil {
		return 0, err
	}

	major, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || major > maxAmount/minorPerMajor {
		return 0, errAmount
	}

	minor := major*minorPerMajor + fraction
	if !validAmount(minor) {
		return 0, errAmount
	}

	return minor, nil
}

func amountSeparators(input string) (string, string) {
	dot := strings.LastIndexByte(input, '.')

	comma := strings.LastIndexByte(input, ',')
	switch {
	case dot >= 0 && comma >= 0:
		if dot > comma {
			return ".", ","
		}

		return ",", "."
	case dot >= 0:
		return singleSeparator(input, dot)
	case comma >= 0:
		return singleSeparator(input, comma)
	default:
		return "", ""
	}
}

func singleSeparator(input string, last int) (string, string) {
	separator := input[last : last+1]
	if len(input)-last-1 <= fractionDigits && strings.Index(input, separator) == last {
		return separator, ""
	}

	return "", separator
}

func splitAmount(input, decimal, grouping string) (string, int64, error) {
	whole := input

	var fraction int64

	if decimal != "" {
		var digits string

		whole, digits, _ = strings.Cut(input, decimal)
		switch len(digits) {
		case 1:
			digits += "0"
		case fractionDigits:
		default:
			return "", 0, errAmount
		}

		value, err := strconv.ParseInt(digits, 10, 64)
		if err != nil {
			return "", 0, errAmount
		}

		fraction = value
	}

	if grouping != "" {
		if !validGrouping(whole, grouping) {
			return "", 0, errAmount
		}

		whole = strings.ReplaceAll(whole, grouping, "")
	}

	return whole, fraction, nil
}

func validGrouping(whole, separator string) bool {
	first, rest, found := strings.Cut(whole, separator)
	if !found || first == "" || len(first) > groupDigits || first[0] == '0' {
		return false
	}

	for part := range strings.SplitSeq(rest, separator) {
		if len(part) != groupDigits {
			return false
		}
	}

	return true
}

func validAmount(amount int64) bool {
	return amount > 0 && amount <= maxAmount
}
