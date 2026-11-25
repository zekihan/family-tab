package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/zekihan/family-tab/internal/ledger"
)

var (
	errRecordType = errors.New("unsupported ledger record type")
	errAliases    = errors.New("aliases must be a JSON array of strings")
)

func (tx *Tx) Records(ctx context.Context) (*ledger.Records, error) {
	var settings ledger.Settings

	records := &ledger.Records{
		Settings:  nil,
		People:    []ledger.Person{},
		Purchases: []ledger.Purchase{},
		Payments:  []ledger.Payment{},
		Refunds:   []ledger.Refund{},
		Payouts:   []ledger.Payout{},
	}

	err := tx.Inner().
		GetContext(ctx, &settings, "SELECT id, time_zone, currency, version FROM settings")
	switch {
	case err == nil:
		records.Settings = &settings
	case !errors.Is(err, sql.ErrNoRows):
		return nil, fmt.Errorf("load settings: %w", err)
	}

	var people []personRow

	queries := []struct {
		dest  any
		query string
	}{
		{&people, "SELECT id, name, payday, archived, aliases, version FROM people ORDER BY id"},
		{&records.Purchases, `SELECT id, person_id, item, total_minor, bought_on, plan, due_date,
			count, first_due, due_day, note, source, version FROM purchases ORDER BY id`},
		{&records.Payments, `SELECT id, person_id, amount_minor, paid_on, note, source, version
			FROM payments ORDER BY id`},
		{&records.Refunds, `SELECT id, purchase_id, amount_minor, refunded_on, note, source, version
			FROM refunds ORDER BY id`},
		{&records.Payouts, `SELECT id, person_id, amount_minor, paid_out_on, note, version
			FROM payouts ORDER BY id`},
	}
	for _, query := range queries {
		err = tx.Inner().SelectContext(ctx, query.dest, query.query)
		if err != nil {
			return nil, fmt.Errorf("load ledger records: %w", err)
		}
	}

	for _, row := range people {
		person, decodeErr := row.person()
		if decodeErr != nil {
			return nil, decodeErr
		}

		records.People = append(records.People, person)
	}

	return records, nil
}

// personRow stores Person.Aliases as a JSON array in the aliases column.
type personRow struct {
	*ledger.Person

	Aliases string `db:"aliases"`
}

func newPersonRow(person *ledger.Person) (*personRow, error) {
	aliases := person.Aliases
	if aliases == nil {
		aliases = []string{}
	}

	encoded, err := json.Marshal(aliases)
	if err != nil {
		return nil, fmt.Errorf("encode aliases of person %q: %w", person.ID, err)
	}

	return &personRow{Person: person, Aliases: string(encoded)}, nil
}

func (row *personRow) person() (ledger.Person, error) {
	person := *row.Person

	err := json.Unmarshal([]byte(row.Aliases), &person.Aliases)
	if err != nil || person.Aliases == nil {
		return person, fmt.Errorf("decode aliases of person %q: %w", person.ID, errAliases)
	}

	return person, nil
}

func saveQuery(record any) string {
	switch record.(type) {
	case *ledger.Settings:
		return `INSERT INTO settings (id, time_zone, currency, version)
			VALUES (:id, :time_zone, :currency, :version)
			ON CONFLICT (id) DO UPDATE SET time_zone = excluded.time_zone, version = excluded.version`
	case *ledger.Person:
		return `INSERT INTO people (id, name, payday, archived, aliases, version)
			VALUES (:id, :name, :payday, :archived, :aliases, :version)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, payday = excluded.payday,
				archived = excluded.archived, aliases = excluded.aliases, version = excluded.version`
	case *ledger.Purchase:
		return `INSERT INTO purchases (id, person_id, item, total_minor, bought_on, plan, due_date,
				count, first_due, due_day, note, source, version)
			VALUES (:id, :person_id, :item, :total_minor, :bought_on, :plan, :due_date,
				:count, :first_due, :due_day, :note, :source, :version)
			ON CONFLICT (id) DO UPDATE SET person_id = excluded.person_id, item = excluded.item,
				total_minor = excluded.total_minor, bought_on = excluded.bought_on, plan = excluded.plan,
				due_date = excluded.due_date, count = excluded.count, first_due = excluded.first_due,
				due_day = excluded.due_day, note = excluded.note, version = excluded.version`
	case *ledger.Payment:
		return `INSERT INTO payments (id, person_id, amount_minor, paid_on, note, source, version)
			VALUES (:id, :person_id, :amount_minor, :paid_on, :note, :source, :version)
			ON CONFLICT (id) DO UPDATE SET person_id = excluded.person_id,
				amount_minor = excluded.amount_minor, paid_on = excluded.paid_on,
				note = excluded.note, version = excluded.version`
	case *ledger.Refund:
		return `INSERT INTO refunds (id, purchase_id, amount_minor, refunded_on, note, source,
				version)
			VALUES (:id, :purchase_id, :amount_minor, :refunded_on, :note, :source, :version)
			ON CONFLICT (id) DO UPDATE SET amount_minor = excluded.amount_minor,
				refunded_on = excluded.refunded_on, note = excluded.note, version = excluded.version`
	case *ledger.Payout:
		return `INSERT INTO payouts (id, person_id, amount_minor, paid_out_on, note, version)
			VALUES (:id, :person_id, :amount_minor, :paid_out_on, :note, :version)
			ON CONFLICT (id) DO UPDATE SET person_id = excluded.person_id,
				amount_minor = excluded.amount_minor, paid_out_on = excluded.paid_out_on,
				note = excluded.note, version = excluded.version`
	default:
		return ""
	}
}

func (tx *Tx) SaveRecord(ctx context.Context, record any) error {
	query := saveQuery(record)
	if query == "" {
		return fmt.Errorf("save %T: %w", record, errRecordType)
	}

	if person, ok := record.(*ledger.Person); ok {
		row, err := newPersonRow(person)
		if err != nil {
			return err
		}

		record = row
	}

	_, err := tx.Inner().NamedExecContext(ctx, query, record)
	if err != nil {
		return fmt.Errorf("save ledger record of type %T: %w", record, err)
	}

	return nil
}

func (tx *Tx) DeleteRecord(ctx context.Context, recordType, id string) error {
	var query string

	switch recordType {
	case ledger.TypePerson:
		query = "DELETE FROM people WHERE id = ?"
	case ledger.TypePurchase:
		query = "DELETE FROM purchases WHERE id = ?"
	case ledger.TypePayment:
		query = "DELETE FROM payments WHERE id = ?"
	case ledger.TypeRefund:
		query = "DELETE FROM refunds WHERE id = ?"
	case ledger.TypePayout:
		query = "DELETE FROM payouts WHERE id = ?"
	default:
		return fmt.Errorf("delete %q: %w", recordType, errRecordType)
	}

	_, err := tx.Inner().ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("delete ledger record of type %q: %w", recordType, err)
	}

	return nil
}

func (tx *Tx) ReplaceRecords(ctx context.Context, records *ledger.Records) error {
	_, err := tx.Inner().ExecContext(ctx, `
		DELETE FROM refunds;
		DELETE FROM payouts;
		DELETE FROM payments;
		DELETE FROM purchases;
		DELETE FROM people;
		DELETE FROM settings;`)
	if err != nil {
		return fmt.Errorf("clear ledger rows: %w", err)
	}

	if records.Settings != nil {
		err = tx.SaveRecord(ctx, records.Settings)
		if err != nil {
			return err
		}
	}

	for _, save := range []func() error{
		func() error { return saveRows(ctx, tx, records.People) },
		func() error { return saveRows(ctx, tx, records.Purchases) },
		func() error { return saveRows(ctx, tx, records.Payments) },
		func() error { return saveRows(ctx, tx, records.Refunds) },
		func() error { return saveRows(ctx, tx, records.Payouts) },
	} {
		err = save()
		if err != nil {
			return err
		}
	}

	return nil
}

func saveRows[T any](ctx context.Context, tx *Tx, records []T) error {
	for index := range records {
		err := tx.SaveRecord(ctx, &records[index])
		if err != nil {
			return err
		}
	}

	return nil
}
