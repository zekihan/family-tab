package ledger

import (
	"slices"
	"unicode/utf8"
)

const (
	maxAliases     = 20
	maxAliasLength = 40
)

func validateAliases(person *Person) *RuleError {
	if len(person.Aliases) > maxAliases {
		return rule(CodeInvalid, "a person can have at most 20 aliases")
	}

	seen := map[string]bool{NormalizeName(person.Name): true}
	for _, alias := range person.Aliases {
		key := NormalizeName(alias)
		if key == "" || alias != TrimName(alias) || utf8.RuneCountInString(alias) > maxAliasLength {
			return rule(CodeInvalid, "each alias must be trimmed and contain 1 to 40 characters")
		}

		if seen[key] {
			return rule(CodeInvalid, "aliases must differ from each other and from the name")
		}

		seen[key] = true
	}

	return nil
}

// validateAliasConflicts compares the person's normalized name and aliases
// with every other person's. Name-to-name matches are allowed.
func validateAliasConflicts(people []Person, person *Person) *RuleError {
	name := NormalizeName(person.Name)
	aliases := aliasKeys(person)

	var blocking []string

	for i := range people {
		other := &people[i]
		if other.ID == person.ID {
			continue
		}

		otherAliases := aliasKeys(other)
		if aliases[NormalizeName(other.Name)] || otherAliases[name] ||
			sharesKey(aliases, otherAliases) {
			blocking = append(blocking, other.ID)
		}
	}

	if len(blocking) == 0 {
		return nil
	}

	slices.Sort(blocking)

	return rule(CodeAliasConflict, "a name or alias matches another person", blocking...)
}

func aliasKeys(person *Person) map[string]bool {
	keys := make(map[string]bool, len(person.Aliases))
	for _, alias := range person.Aliases {
		keys[NormalizeName(alias)] = true
	}

	return keys
}

func sharesKey(left, right map[string]bool) bool {
	for key := range left {
		if right[key] {
			return true
		}
	}

	return false
}
