// Package protocol defines the sync and backup wire types from
// docs/PROTOCOL.md. It holds no behavior.
package protocol

import (
	"encoding/json"

	"github.com/zekihan/family-tab/internal/ledger"
)

// HeaderName and HeaderValue form the custom header every /api request
// carries.
const (
	HeaderName  = "X-Family-Tab"
	HeaderValue = "1"
)

// Receipt and result statuses.
const (
	StatusApplied  = "applied"
	StatusRejected = "rejected"
	StatusConflict = "conflict"
	StatusHeld     = "held"
	StatusSkipped  = "skipped"

	CodeGenerationMismatch   = "generation_mismatch"
	CodeDependencyNotApplied = "dependency_not_applied"
	CodeRevisionMismatch     = "revision_mismatch"
)

// Operation is one queued client change. Record, Patch and PreImage hold
// raw JSON because their shape depends on RecordType.
type Operation struct {
	BaseVersion     *string         `json:"baseVersion,omitempty"`
	ID              string          `json:"id"`
	Generation      string          `json:"generation"`
	CreatedAt       string          `json:"createdAt"`
	Kind            string          `json:"kind"`
	RecordType      string          `json:"recordType"`
	RecordID        string          `json:"recordId"`
	Record          json.RawMessage `json:"record,omitempty"`
	Patch           json.RawMessage `json:"patch,omitempty"`
	PreImage        json.RawMessage `json:"preImage,omitempty"`
	AlreadyReturned bool            `json:"alreadyReturned,omitempty"`
}

// Receipt is the stored outcome of a committed operation.
type Receipt struct {
	Code       *string         `json:"code"`
	Reason     *string         `json:"reason"`
	OpID       string          `json:"opId"`
	Status     string          `json:"status"`
	Generation string          `json:"generation"`
	Current    json.RawMessage `json:"current"`
	Blocking   []string        `json:"blocking"`
	Revision   int64           `json:"revision"`
}

// OpResult is one entry of a /api/sync/ops response: a Receipt, or a held or
// skipped result that is not stored.
type OpResult struct {
	Code       *string         `json:"code"`
	Reason     *string         `json:"reason,omitempty"`
	OpID       string          `json:"opId"`
	Status     string          `json:"status"`
	Generation string          `json:"generation,omitempty"`
	Current    json.RawMessage `json:"current,omitempty"`
	Blocking   []string        `json:"blocking,omitempty"`
	Revision   int64           `json:"revision,omitempty"`
}

type Snapshot struct { //nolint:govet // Embedded records first keep the JSON readable.
	ledger.Records

	Generation string `json:"generation"`
	Revision   int64  `json:"revision"`
}

type ReceiptsRequest struct {
	OpIDs []string `json:"opIds"`
}

type ReceiptsResponse struct {
	Generation string    `json:"generation"`
	Receipts   []Receipt `json:"receipts"`
}

type OpsItem struct {
	Deps []string  `json:"deps"`
	Op   Operation `json:"op"`
}

type OpsRequest struct {
	Items []OpsItem `json:"items"`
}

type OpsResponse struct {
	Generation string     `json:"generation"`
	Results    []OpResult `json:"results"`
}

type UnappliedOperation struct {
	Reason       *string   `json:"reason"`
	Dependencies []string  `json:"dependencies"`
	Op           Operation `json:"op"`
	Order        int       `json:"order"`
}

// BackupFormat and BackupFormatVersion identify an export file.
const (
	BackupFormat        = "family-tab-backup"
	BackupFormatVersion = 1
)

type BackupFile struct {
	Format        string               `json:"format"`
	ExportedAt    string               `json:"exportedAt"`
	Currency      string               `json:"currency"`
	TimeZone      string               `json:"timeZone"`
	People        []ledger.Person      `json:"people"`
	Purchases     []ledger.Purchase    `json:"purchases"`
	Payments      []ledger.Payment     `json:"payments"`
	Refunds       []ledger.Refund      `json:"refunds"`
	Payouts       []ledger.Payout      `json:"payouts"`
	Unapplied     []UnappliedOperation `json:"unapplied"`
	FormatVersion int                  `json:"formatVersion"`
}

type RestoreRequest struct {
	OpID             string     `json:"opId"`
	Backup           BackupFile `json:"backup"`
	ExpectedRevision int64      `json:"expectedRevision"`
}

type RestoreResult struct {
	Code       *string `json:"code"`
	Reason     *string `json:"reason"`
	OpID       string  `json:"opId"`
	Status     string  `json:"status"`
	Generation string  `json:"generation"`
	Revision   int64   `json:"revision"`
}

type Me struct {
	Name    *string `json:"name"`
	Email   *string `json:"email"`
	Subject string  `json:"subject"`
}

type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}
