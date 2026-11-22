// Package ledger holds the Family Tab record types and the pure balance and
// validation rules (DESIGN.md sections 5 and 8). It performs no I/O: every
// function takes the records and an explicit today date.
package ledger

// Plan values for Purchase.Plan.
const (
	PlanOnce         = "once"
	PlanInstallments = "installments"
)

// Source values for Purchase.Source, Payment.Source and Refund.Source.
const (
	SourceApp   = "app"
	SourceAgent = "agent"
)

// SettingsID is the fixed ID of the ledger settings record.
const SettingsID = "ledger"

// CurrencyTRY is the only currency in v1.
const CurrencyTRY = "TRY"

// Dates are calendar dates formatted as YYYY-MM-DD.

type Settings struct {
	ID       string `json:"id"       db:"id"`
	TimeZone string `json:"timeZone" db:"time_zone"`
	Currency string `json:"currency" db:"currency"`
	Version  string `json:"version"  db:"version"`
}

type Person struct {
	Payday   *int     `json:"payday"   db:"payday"`
	ID       string   `json:"id"       db:"id"`
	Name     string   `json:"name"     db:"name"`
	Version  string   `json:"version"  db:"version"`
	Aliases  []string `json:"aliases"  db:"-"`
	Archived bool     `json:"archived" db:"archived"`
}

type Purchase struct {
	DueDate    *string `json:"dueDate"    db:"due_date"`
	Count      *int    `json:"count"      db:"count"`
	FirstDue   *string `json:"firstDue"   db:"first_due"`
	DueDay     *int    `json:"dueDay"     db:"due_day"`
	Note       *string `json:"note"       db:"note"`
	ID         string  `json:"id"         db:"id"`
	PersonID   string  `json:"personId"   db:"person_id"`
	Item       string  `json:"item"       db:"item"`
	BoughtOn   string  `json:"boughtOn"   db:"bought_on"`
	Plan       string  `json:"plan"       db:"plan"`
	Source     string  `json:"source"     db:"source"`
	Version    string  `json:"version"    db:"version"`
	TotalMinor int64   `json:"totalMinor" db:"total_minor"`
}

type Payment struct {
	Note        *string `json:"note"        db:"note"`
	ID          string  `json:"id"          db:"id"`
	PersonID    string  `json:"personId"    db:"person_id"`
	PaidOn      string  `json:"paidOn"      db:"paid_on"`
	Source      string  `json:"source"      db:"source"`
	Version     string  `json:"version"     db:"version"`
	AmountMinor int64   `json:"amountMinor" db:"amount_minor"`
}

type Refund struct {
	Note        *string `json:"note"        db:"note"`
	ID          string  `json:"id"          db:"id"`
	PurchaseID  string  `json:"purchaseId"  db:"purchase_id"`
	RefundedOn  string  `json:"refundedOn"  db:"refunded_on"`
	Source      string  `json:"source"      db:"source"`
	Version     string  `json:"version"     db:"version"`
	AmountMinor int64   `json:"amountMinor" db:"amount_minor"`
}

type Payout struct {
	Note        *string `json:"note"        db:"note"`
	ID          string  `json:"id"          db:"id"`
	PersonID    string  `json:"personId"    db:"person_id"`
	PaidOutOn   string  `json:"paidOutOn"   db:"paid_out_on"`
	Version     string  `json:"version"     db:"version"`
	AmountMinor int64   `json:"amountMinor" db:"amount_minor"`
}

// Records is the whole ledger. Settings is nil until setup completes.
type Records struct {
	Settings  *Settings  `json:"settings"`
	People    []Person   `json:"people"`
	Purchases []Purchase `json:"purchases"`
	Payments  []Payment  `json:"payments"`
	Refunds   []Refund   `json:"refunds"`
	Payouts   []Payout   `json:"payouts"`
}

// ScheduledAmount is one derived installment (sequence 1 for a one-time
// purchase). DueOn is nil only for an undated one-time purchase.
type ScheduledAmount struct {
	DueOn         *string `json:"dueOn"`
	PurchaseID    string  `json:"purchaseId"`
	Sequence      int     `json:"sequence"`
	BaseMinor     int64   `json:"baseMinor"`
	AdjustedMinor int64   `json:"adjustedMinor"`
}

// PersonBalance holds the figures the server needs for payout checks. The
// client computes the display-only figures.
type PersonBalance struct {
	PersonID         string `json:"personId"`
	PaymentsReceived int64  `json:"paymentsReceived"`
	CashReturned     int64  `json:"cashReturned"`
	NetReceipts      int64  `json:"netReceipts"`
	Credit           int64  `json:"credit"`
	CashShortfall    int64  `json:"cashShortfall"`
}

// Rejection codes shared with the receipts in docs/PROTOCOL.md section 4.
const (
	CodeConflict            = "conflict"
	CodeNotFound            = "not_found"
	CodeDuplicateID         = "duplicate_id"
	CodeInvalid             = "invalid"
	CodeRefundsExceedTotal  = "refunds_exceed_total"
	CodeArchivedPerson      = "archived_person"
	CodePurchaseHasRefunds  = "purchase_has_refunds"
	CodePersonHasRecords    = "person_has_records"
	CodePayoutExceedsCredit = "payout_exceeds_credit"
	CodeNotSetup            = "not_setup"
	CodeAliasConflict       = "alias_conflict"
)

// RuleError is a failed record or change rule.
type RuleError struct {
	Code     string   `json:"code"`
	Reason   string   `json:"reason"`
	Blocking []string `json:"blocking"`
}

func (v *RuleError) Error() string { return v.Code + ": " + v.Reason }

// Change kinds and record types used by ValidateChange.
const (
	KindCreate = "create"
	KindUpdate = "update"
	KindDelete = "delete"

	TypeSettings = "settings"
	TypePerson   = "person"
	TypePurchase = "purchase"
	TypePayment  = "payment"
	TypeRefund   = "refund"
	TypePayout   = "payout"
)

// Change describes one operation already applied to produce the after
// records passed to ValidateChange.
type Change struct {
	Kind            string
	RecordType      string
	RecordID        string
	AlreadyReturned bool
}
