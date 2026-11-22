// Package backup periodically copies the live SQLite database with VACUUM
// INTO so volume snapshots always contain a consistent, restorable file
// (TECH_STACK.md section 6, Database backup).
package backup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

const (
	directoryMode = 0o700
	filePrefix    = "family-tab-"
	fileSuffix    = ".db"
	fileTime      = "20060102T150405.000000000Z"
)

var errInvalidSchedule = errors.New(
	"backup interval must be positive and retention must be nonnegative",
)

// Run copies the database into dir every interval, keeping the newest keep
// files, until ctx is done.
func Run(ctx context.Context, db *sqlx.DB, dir string, interval time.Duration, keep int) error {
	if interval <= 0 || keep < 0 {
		return errInvalidSchedule
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for ctx.Err() == nil {
		err := copyDatabase(ctx, db, dir, keep, time.Now())
		if err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "Database backup failed", slog.Any("error", err))
		}

		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}

	return fmt.Errorf("stop database backups: %w", ctx.Err())
}

func copyDatabase(ctx context.Context, db *sqlx.DB, dir string, keep int, now time.Time) error {
	err := os.MkdirAll(dir, directoryMode)
	if err != nil {
		return fmt.Errorf("create backup directory: %w", err)
	}

	temp, err := os.CreateTemp(dir, ".family-tab-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary backup: %w", err)
	}

	name := temp.Name()
	defer os.Remove(name)

	err = temp.Close()
	if err != nil {
		return fmt.Errorf("close temporary backup: %w", err)
	}

	_, err = db.ExecContext(ctx, "VACUUM INTO ?", name)
	if err != nil {
		return fmt.Errorf("copy sqlite database: %w", err)
	}

	final := filepath.Join(dir, filePrefix+now.UTC().Format(fileTime)+fileSuffix)

	err = os.Rename(name, final)
	if err != nil {
		return fmt.Errorf("publish sqlite backup: %w", err)
	}

	return prune(dir, keep)
}

func prune(dir string, keep int) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("list backups: %w", err)
	}

	var names []string

	for _, entry := range entries {
		name := entry.Name()

		timestamp, ok := strings.CutPrefix(name, filePrefix)
		if !ok || !entry.Type().IsRegular() {
			continue
		}

		timestamp, ok = strings.CutSuffix(timestamp, fileSuffix)
		if !ok {
			continue
		}

		_, err = time.Parse(fileTime, timestamp)
		if err == nil {
			names = append(names, name)
		}
	}

	// ReadDir orders entries by filename, which is also timestamp order.
	for _, name := range names[:max(0, len(names)-keep)] {
		err = os.Remove(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("prune backup %q: %w", name, err)
		}
	}

	return nil
}
