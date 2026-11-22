package syncsvc

import (
	"encoding/json"
	"errors"
	"fmt"

	jsonv2 "encoding/json/v2"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
)

var errPayload = errors.New("invalid operation payload")

type recordFields map[string]json.RawMessage

func decodeChange[T any](
	existing *T,
	op *protocol.Operation,
) (*T, json.RawMessage, *ledger.RuleError) {
	var (
		fields  recordFields
		current json.RawMessage
		err     error
	)

	switch op.Kind {
	case ledger.KindCreate:
		fields, err = decodeCreate(new(T), op)
	case ledger.KindUpdate, ledger.KindDelete:
		current, fields, err = encodeRecord(existing)
		if err == nil && (existing == nil || !matchesVersion(fields, op.BaseVersion)) {
			return nil, current, &ledger.RuleError{
				Blocking: nil,
				Code:     ledger.CodeConflict,
				Reason:   "The record changed or was deleted.",
			}
		}

		if err == nil {
			err = decodeEdit[T](op, fields)
		}
	default:
		err = fmt.Errorf("%w: unknown operation kind", errPayload)
	}

	if err != nil {
		return nil, nil, invalid(err.Error())
	}

	if op.Kind == ledger.KindDelete {
		return nil, nil, nil
	}

	record := new(T)
	fields["version"] = json.RawMessage(`"` + op.ID + `"`)

	raw, err := json.Marshal(fields)
	if err != nil {
		return nil, nil, invalid(err.Error())
	}

	err = jsonv2.Unmarshal(raw, record, jsonv2.RejectUnknownMembers(true))
	if err != nil {
		return nil, nil, invalid(err.Error())
	}

	return record, nil, nil
}

func encodeRecord(record any) (json.RawMessage, recordFields, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return nil, nil, fmt.Errorf("encode record: %w", err)
	}

	var fields recordFields

	err = json.Unmarshal(raw, &fields)
	if err != nil {
		return nil, nil, fmt.Errorf("read encoded record: %w", err)
	}

	return raw, fields, nil
}

func matchesVersion(fields recordFields, baseVersion *string) bool {
	return baseVersion != nil && matchesString(fields["version"], *baseVersion)
}

func matchesString(raw json.RawMessage, expected string) bool {
	var value *string

	err := json.Unmarshal(raw, &value)

	return err == nil && value != nil && *value == expected
}

func decodeCreate(record any, op *protocol.Operation) (recordFields, error) {
	if op.BaseVersion != nil || op.Patch != nil || op.PreImage != nil {
		return nil, fmt.Errorf("%w: a create only accepts a record", errPayload)
	}

	_, shape, err := encodeRecord(record)
	if err != nil {
		return nil, err
	}

	delete(shape, "version")

	fields, err := decodeFields(op.Record, shape)
	if err != nil {
		return nil, err
	}

	if len(fields) != len(shape) || !matchesString(fields["id"], op.RecordID) {
		return nil, fmt.Errorf("%w: a create needs all record fields and a matching id", errPayload)
	}

	return fields, nil
}

func decodeEdit[T any](op *protocol.Operation, fields recordFields) error {
	if op.Record != nil {
		return fmt.Errorf("%w: an update or delete cannot carry a create record", errPayload)
	}

	if op.Kind == ledger.KindDelete {
		return decodeDelete[T](op, fields)
	}

	if op.PreImage != nil {
		return fmt.Errorf("%w: an update cannot carry a preImage", errPayload)
	}

	patch, err := decodeFields(op.Patch, fields)
	if err != nil {
		return err
	}

	for key, value := range patch {
		if !patchable(op.RecordType, key) {
			return fmt.Errorf("%w: field %q cannot be patched", errPayload, key)
		}

		fields[key] = value
	}

	return nil
}

func patchable(recordType, field string) bool {
	switch field {
	case "id", "version":
		return false
	case "purchaseId":
		return recordType != ledger.TypeRefund
	case "currency":
		return recordType != ledger.TypeSettings
	default:
		return true
	}
}

func decodeDelete[T any](op *protocol.Operation, fields recordFields) error {
	if op.RecordType == ledger.TypeSettings {
		return fmt.Errorf("%w: settings cannot be deleted", errPayload)
	}

	if op.Patch != nil {
		return fmt.Errorf("%w: a delete cannot carry an update patch", errPayload)
	}

	preImage, err := decodeFields(op.PreImage, fields)
	if err != nil {
		return err
	}

	if len(preImage) != len(fields) || !matchesString(preImage["id"], op.RecordID) ||
		!matchesVersion(preImage, op.BaseVersion) {
		return fmt.Errorf(
			"%w: a delete needs a full preImage with matching id and version",
			errPayload,
		)
	}

	err = jsonv2.Unmarshal(op.PreImage, new(T), jsonv2.RejectUnknownMembers(true))
	if err != nil {
		return fmt.Errorf("decode preImage: %w", err)
	}

	return nil
}

func decodeFields(raw json.RawMessage, shape recordFields) (recordFields, error) {
	var fields recordFields

	err := jsonv2.Unmarshal(raw, &fields)
	if err != nil {
		return nil, fmt.Errorf("decode operation payload: %w", err)
	}

	if fields == nil {
		return nil, fmt.Errorf("%w: the operation payload must be a JSON object", errPayload)
	}

	for key, value := range fields {
		_, ok := shape[key]
		if !ok {
			return nil, fmt.Errorf("%w: unknown field %q", errPayload, key)
		}

		if string(value) == "null" && !nullableField(key) {
			return nil, fmt.Errorf("%w: field %q cannot be null", errPayload, key)
		}
	}

	return fields, nil
}

func nullableField(key string) bool {
	switch key {
	case "payday", "dueDate", "count", "firstDue", "dueDay", "note":
		return true
	default:
		return false
	}
}
