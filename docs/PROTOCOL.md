# Family Tab: Implementation Contracts

Status — implementation contract for [DESIGN.md](DESIGN.md) and [TECH_STACK.md](TECH_STACK.md)

This document fixes the shapes that the Go server, the TypeScript client and the shared fixtures exchange. The Go types live in `internal/ledger/types.go` and `internal/protocol/protocol.go`; the TypeScript types live in `web/src/types.ts`. All three must stay identical in field names and meaning.

## 1. Conventions

- JSON field names are camelCase.
- Dates are calendar dates as `YYYY-MM-DD` strings. Timestamps (only informational, such as `createdAt`) are RFC 3339 UTC strings.
- Amounts are integer kuruş in fields ending in `Minor`.
- Optional fields are present with the value `null`, never omitted, in records. Patches omit unchanged fields.
- IDs are client-generated strings: lowercase UUIDv4 for records and operations. The ledger settings record has the fixed ID `ledger`.
- A record's `version` is the ID of the last operation that changed it (a restore's operation ID for restored records).

## 2. Records

```ts
type DateString = string; // YYYY-MM-DD

interface Settings { id: "ledger"; timeZone: string; currency: "TRY"; version: string }
interface Person { id; name; payday: number | null; archived: boolean; version }
interface Purchase {
  id; personId; item; totalMinor: number; boughtOn: DateString;
  plan: "once" | "installments";
  dueDate: DateString | null;   // once only, else null
  count: number | null;         // installments only, else null
  firstDue: DateString | null;  // installments only, else null
  dueDay: number | null;        // installments only, 1..31, else null
  note: string | null; version;
}
interface Payment { id; personId; amountMinor; paidOn: DateString; note: string | null; version }
interface Refund  { id; purchaseId; amountMinor; refundedOn: DateString; note: string | null; version }
interface Payout  { id; personId; amountMinor; paidOutOn: DateString; note: string | null; version }

interface Records {
  settings: Settings | null; // null until the buyer completes setup
  people: Person[]; purchases: Purchase[]; payments: Payment[]; refunds: Refund[]; payouts: Payout[];
}
```

## 3. Operations

```ts
type RecordType = "settings" | "person" | "purchase" | "payment" | "refund" | "payout";

type Operation = {
  id: string;            // operation ID, UUIDv4
  generation: string;    // ledger generation the operation was created against
  createdAt: string;     // RFC 3339, informational only
  recordType: RecordType;
  recordId: string;
  alreadyReturned?: boolean; // payouts only, see DESIGN.md section 7 Sync rule 6
} & (
  | { kind: "create"; record: RecordWithoutVersion }
  | { kind: "update"; baseVersion: string; patch: Partial<RecordWithoutVersionOrId> }
  | { kind: "delete"; baseVersion: string; preImage: Record }
);
```

- `create.record` is the full record without `version`; its `id` equals `recordId`.
- `update.patch` holds only changed fields. `id`, `version` and `refund.purchaseId` are not patchable. `settings.currency` is not patchable. Setting an optional field to `null` clears it.
- `delete.preImage` is the full record as it was, including its `version`, so Undo works after a reload. Settings cannot be deleted.
- Archiving a person is `update` with `{archived: true}`. Setup is `create` of `settings` with `recordId: "ledger"`, allowed only when no settings exist.

## 4. Receipts

```ts
type ReceiptStatus = "applied" | "rejected" | "conflict";

interface Receipt {
  opId: string;
  status: ReceiptStatus;
  code: ReceiptCode | null;   // null when applied
  reason: string | null;      // human-readable, English
  blocking: string[];         // IDs of records that block the operation, may be empty
  current: Record | null;     // conflict only: the server's current record, null if it was deleted
  generation: string;         // generation at commit time
  revision: number;           // ledger revision after the commit (unchanged for rejections and conflicts)
}

type ReceiptCode =
  | "conflict"               // baseVersion differs from the record's current version, or the record is gone
  | "not_found"              // a referenced record does not exist
  | "duplicate_id"           // create with an ID that already exists
  | "invalid"                // a record rule failed (bad field, date in the future, etc.)
  | "refunds_exceed_total"
  | "archived_person"        // new or moved purchase on an archived person
  | "purchase_has_refunds"   // delete of a purchase with refunds
  | "person_has_records"     // delete of a person still referenced
  | "payout_exceeds_credit"  // new, increased or moved payout above available credit
  | "not_setup";             // any operation other than settings create before setup
```

Every receipt, including rejections and conflicts, is stored and returned again for a retry of the same operation ID. Only `applied` increments the revision.

## 5. HTTP API

All `/api/*` requests must carry the header `X-Family-Tab: 1`. Requests without it get `403` before any other check. JSON bodies only, `Content-Type: application/json`, request bodies capped at 8 MiB. Errors are `{"error": "<code>", "message": "..."}`.

Unauthenticated endpoints:

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness, no header needed |
| `GET /auth/login` | Starts the OIDC flow, sets the transaction cookie (path `/auth/callback`, 10 minutes), redirects to the provider |
| `GET /auth/callback` | Completes the flow, consumes the transaction, sets the session cookie, redirects to `/` |
| `POST /api/logout` | Revokes the session named by the cookie if any, clears the cookie, always `204`, even when the session was already missing or expired |

Authenticated endpoints (`401 {"error":"unauthenticated"}` without a valid session):

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/me` | | `{ "subject": string, "name": string \| null, "email": string \| null }` |
| `GET /api/snapshot` | | `Snapshot` |
| `POST /api/sync/receipts` | `{ "opIds": string[] }` | `{ "generation": string, "receipts": Receipt[] }` (only IDs with a stored receipt) |
| `POST /api/sync/ops` | `{ "items": [{ "op": Operation, "deps": string[] }] }` | `{ "generation": string, "results": OpResult[] }` in request order |
| `POST /api/restore` | `{ "opId": string, "expectedRevision": number, "backup": BackupFile }` | `RestoreResult` |

```ts
interface Snapshot extends Records { generation: string; revision: number }

type OpResult =
  | Receipt                                                          // committed: applied, rejected or conflict
  | { opId: string; status: "held"; code: "generation_mismatch"; generation: string } // not stored
  | { opId: string; status: "skipped"; code: "dependency_not_applied" };              // not stored

interface RestoreResult {
  opId: string;
  status: "applied" | "rejected";
  code: null | "invalid" | "revision_mismatch";
  reason: string | null;
  generation: string;   // new generation when applied
  revision: number;     // expectedRevision + 1 when applied
}
```

- `/api/sync/ops` processes items in order, each in its own transaction. `deps` lists operation IDs from earlier items in the same request; if any of them did not end `applied` (in this request or in a stored receipt), the item is `skipped`. A stored receipt for the operation ID is returned as is, before any other check. An operation whose `generation` differs from the current one, and has no receipt, is `held`.
- `/api/restore` returns a stored receipt for `opId` if one exists. `revision_mismatch` and validation failures are not stored, so the buyer can preview again. Applied restores are stored in the receipts table, which a restore never clears.
- Sessions: cookie `ft_session`, `Secure` (configurable off for local HTTP dev only), `HttpOnly`, `SameSite=Lax`, path `/`. 30-day sliding expiry, renewed at most once an hour on authenticated requests.

## 6. Backup file

```ts
interface BackupFile {
  format: "family-tab-backup";
  formatVersion: 1;
  exportedAt: string;     // RFC 3339
  currency: "TRY";
  timeZone: string;
  people: Person[]; purchases: Purchase[]; payments: Payment[]; refunds: Refund[]; payouts: Payout[]; // `version` optional on import
  unapplied: UnappliedOperation[];
}

interface UnappliedOperation {
  order: number;          // position in the original queue
  op: Operation;          // kind, target ID, payload or pre-image, base version and generation
  dependencies: string[]; // IDs of earlier operations it waits behind
  reason: string | null;  // why it needs review
}
```

## 7. Ledger fixtures

Fixtures live in `testdata/ledger/*.json`, one case per file:

```ts
interface LedgerFixture {
  name: string;
  description: string;      // which DESIGN.md example or table row it covers
  timeZone: string;
  today: DateString;
  records: Omit<Records, "settings">; // `version` may be omitted
  expect: {
    valid?: true | { code: ReceiptCode };  // record rules over the whole ledger (Go and TS)
    schedules?: { [purchaseId: string]: ScheduledAmount[] };   // Go and TS
    people?: { [personId: string]: Partial<PersonBalance> };   // Go: netReceipts, credit, cashShortfall, paymentsReceived, cashReturned; TS: all
    home?: Partial<HomeTotals>;                                // TS only
    comingUp?: ComingUpEntry[];                                // TS only
    chips?: { [personId: string]: StatusChip };                // TS only
    paymentChips?: { [personId: string]: PaymentChip[] };      // TS only
    homeOrder?: string[];                                      // TS only
    purchases?: { [purchaseId: string]: Partial<PurchaseView> }; // TS only, PurchaseView from web/src/ledger/index.ts
  };
}

interface ScheduledAmount { purchaseId: string; sequence: number; baseMinor: number; adjustedMinor: number; dueOn: DateString | null }

interface PersonBalance {
  personId: string;
  leftToPay: number; dueByToday: number; dueNextMonth: number; behindPlan: boolean;
  paymentsReceived: number; cashReturned: number; netReceipts: number;
  credit: number; cashShortfall: number;
  earliestUnpaidFuture: DateString | null;
}

interface HomeTotals { leftToPay: number; dueByToday: number; dueNextMonth: number; credit: number; archivedLeftToPay: number }
interface ComingUpEntry { personId: string; purchaseId: string; sequence: number; dueOn: DateString; remainingMinor: number; archived: boolean }

type StatusChip =
  | { kind: "credit"; amountMinor: number; behindPlan: false }
  | { kind: "allPaid"; behindPlan: false }
  | { kind: "dueByToday"; amountMinor: number; behindPlan: boolean }
  | { kind: "nextDate"; date: DateString; behindPlan: boolean }
  | { kind: "whenTheyCan"; behindPlan: boolean };

interface PaymentChip { kind: "dueByToday" | "throughNextDue" | "everything"; amountMinor: number; shortfallMinor: number }
```

Amount parsing cases live in `testdata/amounts.json` as `[{ "input": string, "minor": number | null }]`, where `null` means rejected. Both languages run every case.

Change-rule cases live in `testdata/changes/*.json`:

```ts
interface ChangeFixture {
  name: string; description: string; timeZone: string; today: DateString;
  records: Omit<Records, "settings">;
  op: Operation;           // applied on top of `records`
  expect: { status: "applied" } | { status: "rejected"; code: ReceiptCode };
}
```

Go runs every change fixture through the server commit path. TypeScript runs the subset its client-side save checks cover.

## 8. Rule interpretations

Where DESIGN.md leaves a detail open, both implementations and the fixtures follow these readings.

### Balances

- **Sort key.** Dated amounts come first, by `dueOn`, then `boughtOn`, then purchase ID (lexicographic, by UTF-16 code units / bytes), then `sequence`. Undated amounts follow, by `boughtOn`, then purchase ID, then `sequence`. Amounts whose adjusted value is zero are skipped by allocation and never count as unpaid.
- **Net receipts** = sum of the person's payments − sum of their payouts. **Cash shortfall** = max(0, −net receipts). Allocation fills amounts in sort order with max(0, net receipts). **Credit** = what is left after every amount is filled.
- **Left to pay** = unpaid purchase amounts + cash shortfall. **Due by today** = unpaid part of dated amounts with `dueOn` ≤ today (excludes the shortfall). **Behind plan** = some dated amount with `dueOn` < today is not fully paid.
- **Due in the next month** = unpaid part of dated amounts with today < `dueOn` ≤ `addMonths(today, 1)`, where `addMonths` keeps today's day clamped to the target month's last day (Jan 31 → Feb 28 or 29).
- **earliestUnpaidFuture** = the earliest `dueOn` > today among amounts not fully paid, or null.
- **Coming up** = across all people, archived included, the not-fully-paid amounts in the Due in the next month window, in the sort order above, first eight. `remainingMinor` is the unpaid part. `archived` is the person's archived flag.
- **Home totals** sum every person, archived included: `leftToPay`, `dueByToday`, `dueNextMonth`, `credit`. `archivedLeftToPay` is the sum of `leftToPay` over archived people. **homeOrder** lists active people only, by Due by today descending, then Left to pay descending, then name (`localeCompare` with locale `tr`, then ID).
- **Status chip**, first match wins: `credit` when credit > 0; `allPaid` when Left to pay is 0; `dueByToday` when Due by today > 0; `nextDate` with `earliestUnpaidFuture` when it is non-null; else `whenTheyCan`. `behindPlan` is the person's Behind plan flag on the last three kinds, and always false on the first two.
- **Payment chips**, in this order, each only when its amount is positive: `dueByToday` = cash shortfall + Due by today; `throughNextDue` = cash shortfall + Due by today + the unpaid parts of every amount due on the earliest `dueOn` > today that is not fully paid (omitted when there is no such date); `everything` = Left to pay. `shortfallMinor` is the cash shortfall included in the chip's amount, the same value on all three. The default chip is the first one returned.
- **PurchaseView** in the client: `leftMinor` = sum of unpaid parts of its adjusted amounts; `refundedMinor` = sum of its refunds; `earliestUnpaidDue` = earliest `dueOn` among its amounts that are not fully paid, or null.

### Record rules

Codes: a missing reference is `not_found`, a repeated ID is `duplicate_id` (IDs are unique across all record types), refunds above the price are `refunds_exceed_total`, and every other record rule is `invalid`.

- Dates must be real calendar dates in `YYYY-MM-DD` form. Settings `timeZone` must be a name that loads from the IANA database (`UTC` included); `""` and `Local` are invalid.
- Names and items are non-empty after trimming. Notes, when non-null, are at most 500 characters; names and items at most 200.
- Amounts and `totalMinor` are integers from 1 through 10,000,000,000.
- Amount input trims Unicode `White_Space` and U+FEFF from both ends before parsing. Whitespace inside the amount is invalid.
- `boughtOn`, `paidOn`, `refundedOn` and `paidOutOn` are ≤ today. `dueDate` and `firstDue` are ≥ `boughtOn`. A refund's `refundedOn` is ≥ its purchase's `boughtOn`.
- Once: `count`, `firstDue` and `dueDay` are null. Installments: `dueDate` is null, `count` is 2–120, `totalMinor` ≥ `count`, `dueDay` is 1–31, and `firstDue` has the day `min(dueDay, daysInMonth(firstDue))`.
- Payday, when non-null, is an integer 1–31.

### Change rules and which records an operation checks

- A change runs the record rules on the created or updated record, and on records whose rule depends on it: for a purchase, its refunds (sum and dates); for a refund, its purchase's refund sum. A create also checks the ID is unused. References must exist after the change.
- The "not in the future" rule is checked only on date fields the change creates or changes, so a time zone change never blocks unrelated later edits.
- A purchase that is created, or whose `personId` changes, must belong to an active person (`archived_person`). Other edits of a purchase on an archived person are allowed.
- Deleting a purchase with refunds is `purchase_has_refunds`, with the refund IDs in `blocking`. Deleting a person referenced by any purchase, payment or payout is `person_has_records`, with those IDs in `blocking`.
- A payout that is created, whose `amountMinor` increases, or whose `personId` changes must satisfy `amountMinor` ≤ the destination person's credit computed on the after-records without this payout, unless `alreadyReturned` is set (`payout_exceeds_credit`). Other changes, including corrections to purchases or payments that leave net receipts negative, are allowed and produce a cash shortfall.
- Settings: `create` only when none exist; `update` may change only `timeZone`. Every other operation before setup is `not_setup`.
