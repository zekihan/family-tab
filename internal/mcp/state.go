package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
)

// toolError is a message for the agent, returned to it as a tool error.
type toolError struct {
	message string
}

func (err *toolError) Error() string { return err.message }

func fail(format string, args ...any) error {
	return &toolError{message: fmt.Sprintf(format, args...)}
}

const notSetUpMessage = "The ledger is not set up yet. Ask the buyer to open the Family Tab app " +
	"and finish setup first."

// state is one consistent read of the ledger with today's date in its time zone.
type state struct {
	snapshot *protocol.Snapshot
	view     *ledger.LedgerView
	today    string
}

func (svc *service) load(ctx context.Context) (*state, error) {
	snapshot, err := svc.ledger.Snapshot(ctx)
	if err != nil {
		return nil, fmt.Errorf("read the ledger: %w", err)
	}

	if snapshot.Settings == nil {
		return nil, fail("%s", notSetUpMessage)
	}

	today, err := ledger.Today(snapshot.Settings.TimeZone, svc.now().Unix())
	if err != nil {
		return nil, fmt.Errorf("calculate today: %w", err)
	}

	return &state{
		snapshot: snapshot,
		view:     ledger.View(&snapshot.Records, today),
		today:    today,
	}, nil
}

func (st *state) person(id string) (*ledger.Person, error) {
	for index := range st.snapshot.People {
		if st.snapshot.People[index].ID == id {
			return &st.snapshot.People[index], nil
		}
	}

	return nil, fail(
		"No person has the id %q. Use list_people or find_person to get a personId.",
		id,
	)
}

func (st *state) purchase(id string) (*ledger.Purchase, error) {
	for index := range st.snapshot.Purchases {
		if st.snapshot.Purchases[index].ID == id {
			return &st.snapshot.Purchases[index], nil
		}
	}

	return nil, fail(
		"No purchase has the id %q. Use find_purchases or get_statement to get a purchaseId.",
		id,
	)
}

func (st *state) personName(id string) string {
	person, err := st.person(id)
	if err != nil {
		return ""
	}

	return person.Name
}

// change describes the one operation a write tool commits.
type change struct {
	record      any
	patch       any
	preImage    any
	kind        string
	recordType  string
	recordID    string
	baseVersion string
}

func createChange(recordType, recordID string, record any) *change {
	return &change{
		record: record, patch: nil, preImage: nil, kind: ledger.KindCreate,
		recordType: recordType, recordID: recordID, baseVersion: "",
	}
}

func updateChange(recordType, recordID, baseVersion string, patch any) *change {
	return &change{
		record: nil, patch: patch, preImage: nil, kind: ledger.KindUpdate,
		recordType: recordType, recordID: recordID, baseVersion: baseVersion,
	}
}

func deleteChange(recordType, recordID, baseVersion string, preImage any) *change {
	return &change{
		record: nil, patch: nil, preImage: preImage, kind: ledger.KindDelete,
		recordType: recordType, recordID: recordID, baseVersion: baseVersion,
	}
}

func (svc *service) operation(st *state, edit *change) (*protocol.Operation, error) {
	op := &protocol.Operation{
		ID:          uuid.NewString(),
		Generation:  st.snapshot.Generation,
		CreatedAt:   svc.now().UTC().Format(time.RFC3339),
		Kind:        edit.kind,
		RecordType:  edit.recordType,
		RecordID:    edit.recordID,
		BaseVersion: nil, Record: nil, Patch: nil, PreImage: nil, AlreadyReturned: false,
	}

	var err error

	switch edit.kind {
	case ledger.KindCreate:
		op.Record, err = json.Marshal(edit.record)
	case ledger.KindUpdate:
		op.BaseVersion = &edit.baseVersion
		op.Patch, err = json.Marshal(edit.patch)
	case ledger.KindDelete:
		op.BaseVersion = &edit.baseVersion
		op.PreImage, err = json.Marshal(edit.preImage)
	}

	if err != nil {
		return nil, fmt.Errorf("encode operation: %w", err)
	}

	return op, nil
}

// write builds one operation from the current ledger and commits it with
// source agent. A restore between the read and the commit holds the operation,
// so it is rebuilt once against the new generation. It returns the ledger as
// it is after the commit.
func (svc *service) write(
	ctx context.Context,
	build func(*state) (*change, error),
) (*state, error) {
	const attempts = 2

	for attempt := range attempts {
		st, err := svc.load(ctx)
		if err != nil {
			return nil, err
		}

		edit, err := build(st)
		if err != nil {
			return nil, err
		}

		op, err := svc.operation(st, edit)
		if err != nil {
			return nil, err
		}

		response, err := svc.ledger.Apply(ctx, &protocol.OpsRequest{
			Items: []protocol.OpsItem{{Deps: []string{}, Op: *op}},
		}, ledger.SourceAgent)
		if err != nil {
			return nil, fmt.Errorf("commit the change: %w", err)
		}

		if len(response.Results) != 1 {
			return nil, fail(
				"The ledger returned an unexpected result. Nothing was recorded for certain; check before retrying.",
			)
		}

		result := &response.Results[0]
		if result.Status == protocol.StatusApplied {
			return svc.load(ctx)
		}

		held := result.Status == protocol.StatusHeld
		if held && attempt+1 < attempts {
			continue
		}

		return nil, rejection(result)
	}

	return nil, fail("The change could not be committed.")
}

func rejection(result *protocol.OpResult) error {
	code, reason := "", ""

	if result.Code != nil {
		code = *result.Code
	}

	if result.Reason != nil {
		reason = *result.Reason
	}

	message := fmt.Sprintf(
		"The ledger did not accept the change (%s, code %s).",
		result.Status,
		code,
	)
	if reason != "" {
		message += " Reason: " + reason
	}

	if len(result.Blocking) > 0 {
		message += " Blocking records: " + strings.Join(result.Blocking, ", ") + "."
	}

	if result.Status == protocol.StatusHeld {
		message += " The ledger was restored while the change was being made; read it again and retry."
	}

	return &toolError{message: message}
}
