package mcp

import (
	"slices"
	"testing"

	"github.com/zekihan/family-tab/internal/ledger"
)

func person(id, name string, archived bool, aliases ...string) ledger.Person {
	if aliases == nil {
		aliases = []string{}
	}

	return ledger.Person{
		Payday: nil, ID: id, Name: name, Version: "", Aliases: aliases, Archived: archived,
	}
}

func testPeople() []ledger.Person {
	return []ledger.Person{
		person("ayse", "Ayşe", false, "Ayşe Teyze"),
		person("dad", "Dad", false, "Baba"),
		person("mom", "Mom", false, "Anne", "Annem"),
		person("ibrahim", "İbrahim Yılmaz", true),
		person("hatice", "Hatice Hanım", false),
		person("mehmetali", "Mehmet Ali Kaya", false),
		person("mehmetalp", "Mehmet Alp Kayacı", false),
	}
}

func ids(people []ledger.Person) []string {
	result := make([]string, 0, len(people))
	for _, person := range people {
		result = append(result, person.ID)
	}

	return result
}

func TestFindPerson(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		query       string
		exact       string
		suggestions []string
	}{
		{"exact name", "Dad", "dad", nil},
		{"exact alias", "baba", "dad", nil},
		{"upper case Turkish", "AYŞE", "ayse", nil},
		{"unaccented", "Ayse", "ayse", nil},
		{"dotted capital", "IBRAHIM YILMAZ", "ibrahim", nil},
		{"extra spaces", "  Ayşe   Teyze ", "ayse", nil},
		{"near alias is a suggestion", "babam", "", []string{"dad"}},
		{"prefix of a word", "meh", "", []string{"mehmetali", "mehmetalp"}},
		{"word prefix", "yilm", "", []string{"ibrahim"}},
		{"near alias with one extra letter", "annes", "", []string{"mom"}},
		{"short prefix is ignored", "ha", "", nil},
		{"three letter prefix", "hat", "", []string{"hatice"}},
		{"typo of a name", "hatise hanim", "", []string{"hatice"}},
		{"typo of one word only is not enough", "hatise", "", nil},
		{"swap counts as one", "dda", "", nil},
		{"too short for distance", "mim", "", nil},
		{"dotless i is folded", "hatice hanim", "hatice", nil},
		{"distance 2 for long names typo", "hatice hunmm", "", []string{"hatice"}},
		{"unknown", "zeynep", "", nil},
		{"empty", "   ", "", nil},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			exact, suggestions := findPerson(testPeople(), test.query)

			gotExact := ""
			if exact != nil {
				gotExact = exact.ID
			}

			if gotExact != test.exact {
				t.Fatalf("exact = %q, want %q", gotExact, test.exact)
			}

			got := ids(suggestions)
			if !slices.Equal(got, test.suggestions) &&
				(len(got) != 0 || len(test.suggestions) != 0) {
				t.Fatalf("suggestions = %v, want %v", got, test.suggestions)
			}
		})
	}
}

func TestFindPersonSharedNameIsNotExact(t *testing.T) {
	t.Parallel()

	people := []ledger.Person{
		person("a", "Ali", false), person("b", "ALİ", false), person("c", "Alim", false),
	}

	exact, suggestions := findPerson(people, "ali")
	if exact != nil {
		t.Fatalf("exact = %+v, want none", exact)
	}

	if got := ids(suggestions); !slices.Equal(got, []string{"a", "b", "c"}) {
		t.Fatalf("suggestions = %v", got)
	}
}

func TestEditDistance(t *testing.T) {
	t.Parallel()

	tests := []struct {
		left, right string
		want        int
	}{
		{"", "", 0},
		{"baba", "babam", 1},
		{"abcd", "abdc", 1},
		{"abcd", "acbd", 1},
		{"kitten", "sitting", 3},
		{"şeker", "seker", 1},
		{"ca", "abc", 3},
	}

	for _, test := range tests {
		got := editDistance([]rune(test.left), []rune(test.right))
		if got != test.want {
			t.Errorf("editDistance(%q, %q) = %d, want %d", test.left, test.right, got, test.want)
		}
	}
}
