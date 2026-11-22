package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zekihan/family-tab/internal/store"
)

func TestCopyAndPrune(t *testing.T) {
	t.Parallel()

	st, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "live.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	dir := t.TempDir()
	now := time.Date(2025, time.November, 22, 12, 0, 0, 0, time.UTC)

	const keep = 2

	err = os.WriteFile(filepath.Join(dir, "keep-me.txt"), nil, 0o600)
	if err != nil {
		t.Fatal(err)
	}

	for index := range keep + 1 {
		_, err = st.DB().ExecContext(t.Context(), "UPDATE ledger_meta SET revision = ?", index)
		if err != nil {
			t.Fatal(err)
		}

		err = copyDatabase(
			t.Context(),
			st.DB(),
			dir,
			keep,
			now.Add(time.Duration(index)*time.Second),
		)
		if err != nil {
			t.Fatal(err)
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != keep+1 {
		t.Fatalf("backup directory = %v, error %v", entries, err)
	}

	assertBackupNames(t, entries, now, keep)

	verifyBackupRevision(t, filepath.Join(dir, entries[1].Name()), keep)
}

func assertBackupNames(t *testing.T, entries []os.DirEntry, now time.Time, keep int) {
	t.Helper()

	for index, entry := range entries[:keep] {
		offset := time.Duration(index+1) * time.Second

		want := filePrefix + now.Add(offset).Format(fileTime) + fileSuffix
		if entry.Name() != want {
			t.Fatalf("backup %q, want %q", entry.Name(), want)
		}
	}

	if entries[keep].Name() != "keep-me.txt" {
		t.Fatalf("unrelated file removed: %v", entries)
	}
}

func verifyBackupRevision(t *testing.T, path string, want int) {
	t.Helper()

	copied, err := store.Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = copied.Close() })

	var revision int

	err = copied.DB().GetContext(t.Context(), &revision, "SELECT revision FROM ledger_meta")
	if err != nil || revision != want {
		t.Fatalf("backup revision = %d, error %v", revision, err)
	}
}

func TestRunBacksUpBeforeFirstTick(t *testing.T) {
	t.Parallel()

	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	dir := t.TempDir()

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	done := make(chan error, 1)

	go func() {
		done <- Run(ctx, st.DB(), dir, time.Hour, 1)
	}()

	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()

	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case err = <-done:
			t.Fatalf("Run stopped before cancellation: %v", err)
		case <-deadline.C:
			t.Fatal("no initial backup produced")
		case <-ticker.C:
			entries, readErr := os.ReadDir(dir)
			if readErr != nil {
				t.Fatal(readErr)
			}

			if len(entries) == 1 && filepath.Ext(entries[0].Name()) == fileSuffix {
				cancel()

				err = <-done
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}

				return
			}
		}
	}
}
