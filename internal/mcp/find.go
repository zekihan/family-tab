package mcp

import (
	"cmp"
	"slices"
	"strings"

	"github.com/zekihan/family-tab/internal/ledger"
)

const (
	minPrefixLength   = 3
	minNearLength     = 4
	minFarLength      = 8
	nearDistance      = 1
	farDistance       = 2
	prefixRank        = 0
	noMatchRank       = -1
	editCostPerChange = 1
)

type personKeys struct {
	person *ledger.Person
	keys   []string
}

// findPerson implements the find_person rules: exact is the single person
// whose normalized name or alias equals the normalized query. Otherwise the
// near matches are suggestions, ordered by distance then name. Several people
// that share the exact key are all returned as suggestions, never as exact.
func findPerson(people []ledger.Person, query string) (*ledger.Person, []ledger.Person) {
	needle := ledger.NormalizeName(query)
	if needle == "" {
		return nil, []ledger.Person{}
	}

	candidates := make([]personKeys, 0, len(people))

	for index := range people {
		person := &people[index]
		keys := []string{ledger.NormalizeName(person.Name)}

		for _, alias := range person.Aliases {
			keys = append(keys, ledger.NormalizeName(alias))
		}

		candidates = append(candidates, personKeys{person: person, keys: keys})
	}

	var exact []*ledger.Person

	for _, candidate := range candidates {
		if slices.Contains(candidate.keys, needle) {
			exact = append(exact, candidate.person)
		}
	}

	if len(exact) == 1 {
		return exact[0], []ledger.Person{}
	}

	type ranked struct {
		person   *ledger.Person
		sortName string
		rank     int
	}

	var matches []ranked

	for _, candidate := range candidates {
		rank := suggestionRank(
			candidate.keys,
			needle,
			len(exact) > 0 && slices.Contains(exact, candidate.person),
		)
		if rank != noMatchRank {
			matches = append(matches, ranked{
				person:   candidate.person,
				sortName: ledger.NormalizeName(candidate.person.Name),
				rank:     rank,
			})
		}
	}

	slices.SortFunc(matches, func(left, right ranked) int {
		return cmp.Or(
			cmp.Compare(left.rank, right.rank),
			cmp.Compare(left.sortName, right.sortName),
			cmp.Compare(left.person.ID, right.person.ID),
		)
	})

	suggestions := make([]ledger.Person, 0, len(matches))
	for _, match := range matches {
		suggestions = append(suggestions, *match.person)
	}

	return nil, suggestions
}

// suggestionRank returns the smallest rank over the person's keys, or
// noMatchRank. A shared exact key and a prefix match rank 0.
func suggestionRank(keys []string, needle string, sharesExact bool) int {
	if sharesExact {
		return prefixRank
	}

	best := noMatchRank

	for _, key := range keys {
		rank := keyRank(key, needle)
		if rank != noMatchRank && (best == noMatchRank || rank < best) {
			best = rank
		}
	}

	return best
}

func keyRank(key, needle string) int {
	needleRunes := []rune(needle)

	if len(needleRunes) >= minPrefixLength {
		if strings.HasPrefix(key, needle) {
			return prefixRank
		}

		for word := range strings.FieldsSeq(key) {
			if strings.HasPrefix(word, needle) {
				return prefixRank
			}
		}
	}

	keyRunes := []rune(key)
	shortest := min(len(needleRunes), len(keyRunes))

	allowed := 0

	switch {
	case shortest >= minFarLength:
		allowed = farDistance
	case shortest >= minNearLength:
		allowed = nearDistance
	}

	if allowed == 0 {
		return noMatchRank
	}

	distance := editDistance(needleRunes, keyRunes)
	if distance > allowed {
		return noMatchRank
	}

	return distance
}

// editDistance is the optimal string alignment form of the
// Damerau-Levenshtein distance: insertions, deletions, substitutions and
// swaps of adjacent runes each cost one.
func editDistance(left, right []rune) int {
	rows := make([][]int, len(left)+1)
	for row := range rows {
		rows[row] = make([]int, len(right)+1)
		rows[row][0] = row
	}

	for column := range right {
		rows[0][column+1] = column + 1
	}

	for row := 1; row <= len(left); row++ {
		for column := 1; column <= len(right); column++ {
			cost := editCostPerChange
			if left[row-1] == right[column-1] {
				cost = 0
			}

			best := min(
				rows[row-1][column]+editCostPerChange,
				rows[row][column-1]+editCostPerChange,
				rows[row-1][column-1]+cost,
			)

			if row > 1 && column > 1 && left[row-1] == right[column-2] &&
				left[row-2] == right[column-1] {
				best = min(best, rows[row-2][column-2]+editCostPerChange)
			}

			rows[row][column] = best
		}
	}

	return rows[len(left)][len(right)]
}
