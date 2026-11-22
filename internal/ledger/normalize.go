package ledger

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

var nameFolds = map[rune]rune{
	'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u',
}

const combiningDotAbove = '\u0307'

func isNameSpace(char rune) bool {
	return unicode.Is(unicode.White_Space, char) || char == '\uFEFF'
}

// TrimName trims Unicode White_Space and U+FEFF from both ends of a name or
// alias and collapses internal whitespace runs to one ASCII space.
func TrimName(input string) string {
	return strings.Join(strings.FieldsFunc(input, isNameSpace), " ")
}

// NormalizeName returns the comparison key for person names and aliases:
// NFC, trimmed, Turkish-aware lowercase, with Turkish and circumflex letters
// folded to ASCII.
func NormalizeName(input string) string {
	lower := strings.ToLowerSpecial(unicode.TurkishCase, TrimName(norm.NFC.String(input)))

	return strings.Map(func(char rune) rune {
		if char == combiningDotAbove {
			return -1
		}

		if folded, ok := nameFolds[char]; ok {
			return folded
		}

		return char
	}, lower)
}
