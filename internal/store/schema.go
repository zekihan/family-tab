// Package store owns the SQLite database: schema migrations, ledger rows,
// operation receipts, sessions and sign-in transactions.
package store

// Migrations are applied in order; PRAGMA user_version records how many ran.
// Never edit an applied migration: append a new one.
var Migrations = []string{
	// Schema v1 - Initial schema.
	`
	CREATE TABLE ledger_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		generation TEXT NOT NULL,
		revision INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE settings (
		id TEXT PRIMARY KEY CHECK (id = 'ledger'),
		time_zone TEXT NOT NULL,
		currency TEXT NOT NULL CHECK (currency = 'TRY'),
		version TEXT NOT NULL
	);

	CREATE TABLE people (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		payday INTEGER CHECK (payday BETWEEN 1 AND 31),
		archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
		version TEXT NOT NULL
	);

	CREATE TABLE purchases (
		id TEXT PRIMARY KEY,
		person_id TEXT NOT NULL REFERENCES people(id),
		item TEXT NOT NULL,
		total_minor INTEGER NOT NULL,
		bought_on TEXT NOT NULL,
		plan TEXT NOT NULL CHECK (plan IN ('once', 'installments')),
		due_date TEXT,
		count INTEGER,
		first_due TEXT,
		due_day INTEGER,
		note TEXT,
		version TEXT NOT NULL
	);
	CREATE INDEX idx_purchases_person ON purchases(person_id);

	CREATE TABLE payments (
		id TEXT PRIMARY KEY,
		person_id TEXT NOT NULL REFERENCES people(id),
		amount_minor INTEGER NOT NULL,
		paid_on TEXT NOT NULL,
		note TEXT,
		version TEXT NOT NULL
	);
	CREATE INDEX idx_payments_person ON payments(person_id);

	CREATE TABLE refunds (
		id TEXT PRIMARY KEY,
		purchase_id TEXT NOT NULL REFERENCES purchases(id),
		amount_minor INTEGER NOT NULL,
		refunded_on TEXT NOT NULL,
		note TEXT,
		version TEXT NOT NULL
	);
	CREATE INDEX idx_refunds_purchase ON refunds(purchase_id);

	CREATE TABLE payouts (
		id TEXT PRIMARY KEY,
		person_id TEXT NOT NULL REFERENCES people(id),
		amount_minor INTEGER NOT NULL,
		paid_out_on TEXT NOT NULL,
		note TEXT,
		version TEXT NOT NULL
	);
	CREATE INDEX idx_payouts_person ON payouts(person_id);

	-- Receipts live outside the ledger rows, so a restore never erases them.
	-- body is the Receipt or RestoreResult JSON returned on retry.
	CREATE TABLE receipts (
		op_id TEXT PRIMARY KEY,
		status TEXT NOT NULL,
		generation TEXT NOT NULL,
		revision INTEGER NOT NULL,
		body TEXT NOT NULL,
		created_at TEXT NOT NULL
	);

	-- Server-side sessions; token_hash is the SHA-256 of the cookie value.
	CREATE TABLE sessions (
		token_hash TEXT PRIMARY KEY,
		issuer TEXT NOT NULL,
		subject TEXT NOT NULL,
		name TEXT,
		email TEXT,
		created_at TEXT NOT NULL,
		renewed_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE INDEX idx_sessions_expires ON sessions(expires_at);

	-- One-time OIDC sign-in transactions; id_hash is the SHA-256 of the
	-- transaction cookie value.
	CREATE TABLE oidc_transactions (
		id_hash TEXT PRIMARY KEY,
		state TEXT NOT NULL,
		nonce TEXT NOT NULL,
		pkce_verifier TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	`,
	// Schema v2 - Person aliases and record sources.
	`
	-- aliases is a JSON array of strings.
	ALTER TABLE people ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE purchases ADD COLUMN source TEXT NOT NULL DEFAULT 'app'
		CHECK (source IN ('app', 'agent'));
	ALTER TABLE payments ADD COLUMN source TEXT NOT NULL DEFAULT 'app'
		CHECK (source IN ('app', 'agent'));
	ALTER TABLE refunds ADD COLUMN source TEXT NOT NULL DEFAULT 'app'
		CHECK (source IN ('app', 'agent'));
	`,
}
