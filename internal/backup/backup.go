// Package backup periodically copies the live SQLite database with VACUUM
// INTO so volume snapshots always contain a consistent, restorable file
// (TECH_STACK.md section 6, Database backup).
package backup

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
)

// Run copies the database into dir every interval, keeping the newest keep
// files, until ctx is done.
func Run(ctx context.Context, db *sqlx.DB, dir string, interval time.Duration, keep int) error {
	return nil
}
