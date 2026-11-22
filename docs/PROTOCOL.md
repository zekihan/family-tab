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
type Source = "app" | "agent";

interface Person { id; name; payday: number | null; aliases: string[]; archived: boolean; version }
interface Purchase {
  id; personId; item; totalMinor: number; boughtOn: DateString;
  plan: "once" | "installments";
  dueDate: DateString | null;   // once only, else null
  count: number | null;         // installments only, else null
  firstDue: DateString | null;  // installments only, else null
  dueDay: number | null;        // installments only, 1..31, else null
  note: string | null; source: Source; version;
}
interface Payment { id; personId; amountMinor; paidOn: DateString; note: string | null; source: Source; version }
interface Refund  { id; purchaseId; amountMinor; refundedOn: DateString; note: string | null; source: Source; version }
interface Payout  { id; personId; amountMinor; paidOutOn: DateString; note: string | null; version }

interface Records {
  settings: Settings | null; // null until the buyer completes setup
  people: Person[]; purchases: Purchase[]; payments: Payment[]; refunds: Refund[]; payouts: Payout[];
}
```

`aliases` is always present, `[]` when none, and is patchable like `name`. `source` is set by the server when it commits a create: `app` for operations on `/api/sync/ops`, `agent` for operations made by the MCP tools. A restore keeps `source` from the backup records as given. The TypeScript client sets `source: "app"` on its optimistic local copy of a record it creates.

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

- `create.record` is the full record without `version` and, for purchases, payments and refunds, without `source`; its `id` equals `recordId`.
- `update.patch` holds only changed fields. `id`, `version`, `source` and `refund.purchaseId` are not patchable. `settings.currency` is not patchable. Setting an optional field to `null` clears it.
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
  | "invalid"                // a record rule failed (bad field, date in the future, `source` sent by a client, etc.)
  | "refunds_exceed_total"
  | "archived_person"        // new or moved purchase on an archived person
  | "purchase_has_refunds"   // delete of a purchase with refunds
  | "person_has_records"     // delete of a person still referenced
  | "alias_conflict"         // a person's alias or name matches another person's name or alias (section 8)
  | "payout_exceeds_credit"  // new, increased or moved payout above available credit
  | "not_setup";             // any operation other than settings create before setup
```

Every committed sync receipt, including rejections and conflicts, is stored and returned again for a retry of the same operation ID. Only `applied` increments the revision.

## 5. HTTP API

All `/api/*` requests must carry the header `X-Family-Tab: 1`. Requests with a missing or wrong value get `403` before any other check. The API does not enable credentialed CORS. JSON bodies only, `Content-Type: application/json`, request bodies capped at 8 MiB. Errors are `{"error": "<code>", "message": "..."}`.

Unauthenticated endpoints:

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness, no header needed |
| `GET /auth/login` | Starts the OIDC flow, sets the transaction cookie (path `/auth/callback`, 10 minutes), redirects to the provider |
| `GET /auth/callback` | Completes the flow, consumes the transaction, sets the session cookie, redirects to `/` |
| `POST /api/logout` | Revokes the session named by the cookie if any, clears the cookie, always `204`, even when the session was already missing or expired |
| `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | OAuth protected resource metadata for `/mcp`, no header needed |

Authenticated endpoints (without a valid session, `401` with error code `unauthenticated`):

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/me` | | `{ "subject": string, "name": string \| null, "email": string \| null }` |
| `GET /api/snapshot` | | `Snapshot` |
| `POST /api/sync/receipts` | `{ "opIds": string[] }` | `{ "generation": string, "receipts": Receipt[] }` (only IDs with a stored receipt, including applied restores) |
| `POST /api/sync/ops` | `{ "items": [{ "op": Operation, "deps": string[] }] }` | `{ "generation": string, "results": OpResult[] }` in request order |
| `POST /api/restore` | `{ "opId": string, "expectedRevision": number, "backup": BackupFile }` | `RestoreResult` |

`/mcp` (MCP over streamable HTTP, section 9) is not part of `/api`:

- It exists only when the environment variable `MCP_CLIENT_ID` is set. `MCP_AUDIENCE` defaults to `PUBLIC_URL + "/mcp"`.
- It needs no `X-Family-Tab` header. It requires `Authorization: Bearer <JWT>` and answers a missing or bad token with `401` and `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource"`, plus `error="invalid_token"` when a token was present.
- The metadata document is `{ "resource": MCP_AUDIENCE, "authorization_servers": [OIDC_ISSUER], "bearer_methods_supported": ["header"], "scopes_supported": ["openid", "offline_access"] }`.
- Token checks: signature against the issuer's JWKS, algorithm `RS256` only, `iss` equals the issuer, `aud` contains `MCP_AUDIENCE`, `exp` in the future (small skew), sane `nbf` and `iat`, `client_id` (or `azp`) equals `MCP_CLIENT_ID`, and (`iss`, `sub`) is the buyer. The `typ` header, when present, must be `at+jwt` or `application/at+jwt`. Tokens with a `nonce` claim (ID tokens) are rejected.
- The session cookie is not accepted on `/mcp`, and bearer tokens are not accepted on `/api`.

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

- `/api/sync/ops` processes items in order, each in its own transaction. The client lists dependencies from earlier items in the same request in `deps`. The server returns an existing receipt for the operation ID before checking dependencies. If any dependency has no `applied` receipt, the item is `skipped`. After receipt and dependency checks, a different `generation` makes the operation `held`.
- `/api/restore` returns `400` with error code `invalid` for missing or null `expectedRevision` or `backup`, a negative revision, or a missing or empty `opId`. For a complete request it returns a stored receipt for `opId` if one exists. `revision_mismatch` and backup validation failures return a rejected result and are not stored, so the buyer can preview again. Applied restores are stored in the receipts table, which a restore never clears.
- The client sends operations in order in batches of at most 200 items and 1 MiB per JSON body. An operation that cannot fit in a batch goes to review. The client treats a request timeout as a network failure. The timeout is 20 seconds per API request and 60 seconds for `/api/restore`. After a restore times out, sync checks for a receipt by its operation ID. Only **Retry restore** in Settings can resend it, using the same ID. **Cancel** clears the retry. If the original request commits after cancellation, sync still recovers the restored ledger and any unapplied changes from that backup.
- The web server serves existing static files and falls back to `index.html` for app routes. Missing `/assets/*` and other file-like paths return `404`.
- Sessions: cookie `ft_session`, `Secure` (configurable off for local HTTP dev only), `HttpOnly`, `SameSite=Lax`, path `/`. 30-day sliding expiry, renewed at most once an hour on authenticated requests.

## 6. Backup file

```ts
interface BackupFile {
  format: "family-tab-backup";
  formatVersion: 1;
  exportedAt: string;     // RFC 3339 UTC
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

All six collections must be present as arrays, even when empty. Each record must have exactly the fields shown in section 2 (including `aliases`, and `source` which must be `app` or `agent`), with `version` optional on import. Backups stay `formatVersion: 1`. Nullable fields must be present. A restore sets every record version to its operation ID.

An unapplied entry requires `order`, `op`, `dependencies` and `reason`. Only `reason` may be null. Order is a nonnegative safe integer. Operation IDs must be unique, and dependencies must refer to unapplied operations with lower order. Each operation needs a generation, an RFC 3339 UTC `createdAt` and the payload for its kind. Updates and deletes need a non-empty `baseVersion`. If present, `alreadyReturned` must be a boolean on a payout.

## 7. Ledger fixtures

Fixtures live in `testdata/ledger/*.json`, one case per file:

```ts
interface LedgerFixture {
  name: string;
  description: string;      // which DESIGN.md example or table row it covers
  timeZone: string;
  today: DateString;
  records: Omit<Records, "settings">; // `version` may be omitted; `aliases` defaults to [] and `source` to "app"
  expect: {
    valid?: true | { code: ReceiptCode };  // record rules over the whole ledger (Go and TS)
    schedules?: { [purchaseId: string]: ScheduledAmount[] };   // Go and TS
    people?: { [personId: string]: Partial<PersonBalance> };   // Go and TS
    home?: Partial<HomeTotals>;                                // Go and TS
    comingUp?: ComingUpEntry[];                                // Go and TS
    chips?: { [personId: string]: StatusChip };                // Go and TS
    paymentChips?: { [personId: string]: PaymentChip[] };      // Go and TS
    homeOrder?: string[];                                      // TS only, locale collation
    purchases?: { [purchaseId: string]: Partial<PurchaseView> }; // Go and TS, PurchaseView from web/src/ledger/index.ts
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

Go checks every `expect` key except `homeOrder`, using `ledger.View` and `ledger.PaymentChips`.

Amount parsing cases live in `testdata/amounts.json` as `[{ "input": string, "minor": number | null }]`, where `null` means rejected. Both languages run every case.

Change-rule cases live in `testdata/changes/*.json`:

```ts
interface ChangeFixture {
  name: string; description: string; timeZone: string; today: DateString;
  records: Omit<Records, "settings">; // same defaults as ledger fixtures
  op: Operation;           // applied on top of `records`
  expect: { status: "applied" } | { status: "rejected"; code: ReceiptCode };
}
```

Name normalization cases live in `testdata/names.json` as `[{ "input": string, "normalized": string }]`. Both languages run every case.

Add-purchase default cases live in `testdata/defaults.json` as an array of:

```ts
interface DefaultsFixture {
  today: DateString;
  payday: number | null;
  shortcuts: DueShortcuts;   // the payday, end of month and in two weeks dates
  installmentStart: { firstDue: DateString; dueDay: number };
}
```

Both languages run every case against `firstPaydayOnOrAfter`, `dueShortcuts` and `defaultInstallmentStart`. The cases cover month ends, payday 29, 30 and 31, February in leap and non-leap years, payday equal to today's day, and a null payday.

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
- **PurchaseView** in the client: `leftMinor` = sum of unpaid parts of its adjusted amounts; `refundedMinor` = sum of its refunds; `earliestUnpaidDue` = earliest `dueOn` among its amounts that are not fully paid, or null. `payableCount` counts amounts still positive after refunds. `paidCount` counts those paid in full.

### Names

`normalizeName(s)` (Go `ledger.NormalizeName`, TypeScript `normalizeName` in `web/src/ledger`) is used for the alias rules and for person matching:

1. Apply NFC, so composed and decomposed input agree (`s.normalize("NFC")` in TypeScript, `golang.org/x/text/unicode/norm` in Go).
2. Trim Unicode `White_Space` and U+FEFF and collapse inner whitespace runs to one space.
3. Turkish-aware lowercase: `I` to `ı`, `İ` to `i`, then Unicode lowercase of the rest.
4. Fold `ç ğ ı ö ş ü â î û` to `c g i o s u a i u`, and strip a combining dot above (U+0307) left from decomposed input.

### Record rules

Codes: a missing reference is `not_found`, a repeated ID is `duplicate_id` (IDs are unique across all record types), refunds above the price are `refunds_exceed_total`, and every other record rule is `invalid`.

- Dates must be real calendar dates in `YYYY-MM-DD` form. Settings `timeZone` must be a name that loads from the IANA database (`UTC` included); `""` and `Local` are invalid.
- Names and items are non-empty after trimming. Notes, when non-null, are at most 500 Unicode code points. Names and items are at most 200.
- Amounts and `totalMinor` are integers from 1 through 10,000,000,000.
- Amount input trims Unicode `White_Space` and U+FEFF from both ends before parsing. Whitespace inside the amount is invalid.
- `boughtOn`, `paidOn`, `refundedOn` and `paidOutOn` are ≤ today. `dueDate` and `firstDue` are ≥ `boughtOn`. A refund's `refundedOn` is ≥ its purchase's `boughtOn`.
- Once: `count`, `firstDue` and `dueDay` are null. Installments: `dueDate` is null, `count` is 2–120, `totalMinor` ≥ `count`, `dueDay` is 1–31, and `firstDue` has the day `min(dueDay, daysInMonth(firstDue))`.
- Payday, when non-null, is an integer 1–31.
- Aliases: at most 20 per person; each is 1–40 Unicode code points after trimming and not empty; no two aliases of one person normalize equal, and none normalizes equal to the person's own name. All are `invalid`. Stored aliases are trimmed (Unicode `White_Space` and U+FEFF) with inner whitespace runs collapsed to one ASCII space; case is preserved.
- `source` is `app` or `agent`.

### Change rules and which records an operation checks

- A change runs the record rules on the created or updated record, and on records whose rule depends on it: for a purchase, its refunds (sum and dates); for a refund, its purchase's refund sum. A create also checks the ID is unused. References must exist after the change.
- The "not in the future" rule is checked only on date fields the change creates or changes, so a time zone change never blocks unrelated later edits.
- A purchase that is created, or whose `personId` changes, must belong to an active person (`archived_person`). Other edits of a purchase on an archived person are allowed.
- Deleting a purchase with refunds is `purchase_has_refunds`, with the refund IDs in `blocking`. Deleting a person referenced by any purchase, payment or payout is `person_has_records`, with those IDs in `blocking`.
- A payout that is created, whose `amountMinor` increases, or whose `personId` changes must satisfy `amountMinor` ≤ the destination person's credit computed on the after-records without this payout, unless `alreadyReturned` is set (`payout_exceeds_credit`). Other changes, including corrections to purchases or payments that leave net receipts negative, are allowed and produce a cash shortfall.
- `alias_conflict`: a change that creates a person or changes a person's `name` or `aliases` is rejected when a normalized alias or name of that person equals the normalized name or a normalized alias of a different person, archived included. `blocking` holds the other people's IDs. Name against name is not checked, so two people may share a name; only pairs involving at least one alias are.
- A create whose `record` carries `source`, and a patch that carries `source`, are `invalid`. The server sets `source` from the commit path: `syncsvc.Service.Apply` takes a source argument (`ledger.SourceApp`, `ledger.SourceAgent`); the HTTP handler passes app and the MCP tools pass agent.
- Settings: `create` only when none exist; `update` may change only `timeZone`. Every other operation before setup is `not_setup`.

## 9. MCP tools

Server name `family-tab`, official Go SDK, streamable HTTP transport (stateless where the SDK allows), mounted at `/mcp` (section 5). Every write tool builds a normal `Operation` (new UUIDv4 ID, current generation, `createdAt` now) and commits it through `syncsvc.Service.Apply` with source `agent`. A rejection is returned as a tool error carrying the receipt `code`, `reason` and `blocking`. Tools fail with a clear message before setup.

- Amount inputs are strings parsed by `ParseAmount`. Every result echoes amounts both as integer kuruş (`...Minor`) and as formatted TRY strings, such as `"1.299,90 TL"`.
- Dates are `YYYY-MM-DD`. "Today" is in the ledger time zone.
- `personId` comes from `list_people` or `find_person`.
- Tool descriptions are the agent's manual: units, defaults, where IDs come from, and the expectations in DESIGN.md section 7 (ask who and which plan per item, check duplicates first, an exact match is used directly, suggestions need a yes, offer to save new wordings as aliases).

### Read tools

| Tool | Parameters | Result |
| --- | --- | --- |
| `list_people` | none | Active and archived people: `id`, `name`, `aliases`, `payday`, `archived` |
| `find_person` | `query` | `{ exact: Person \| null, suggestions: Person[] }` |
| `get_balance` | `personId` | The person's `PersonBalance` figures, status chip and payment chips |
| `get_statement` | `personId`, `includePaid?` (false), `since?` | The person's balance summary and purchases |
| `get_overview` | none | Each active person's balance summary and `HomeTotals` |
| `coming_up` | none | `ComingUpEntry` list with person and item names |
| `find_purchases` | `query?`, `personId?`, `since?`, `until?` | Matching purchases |
| `check_purchases` | `items: [{ item, price, boughtOn }]` | Per input item, possible duplicates |

- `find_person`: `exact` is the single person whose normalized name or any normalized alias equals `normalizeName(query)`. `suggestions` is filled only when there is no exact match: people where the normalized query (3 or more characters) is a prefix of a normalized name or alias, or of any space-separated word in it; or within Damerau-Levenshtein distance 1 of one (both sides 4 or more characters); or distance 2 (both 8 or more). Ordered by distance, then name. Archived people are included and flagged.
- `get_statement`: purchases with `leftMinor` > 0, or all with `includePaid`. Each has `id`, `item`, `boughtOn`, `plan`, `totalMinor`, `refundedMinor`, `leftMinor`, `source`, `note` and `installments`: the adjusted schedule with `dueOn`, `adjustedMinor`, `paidMinor`, `remainingMinor` and `overdue` (`dueOn` before today and `remainingMinor` > 0). Only unpaid installments are listed unless `includePaid`. `since` filters on `boughtOn`.
- `get_overview`: sorted by Due by today descending, Left to pay descending, then name by `normalizeName`, then ID.
- `find_purchases`: each has `item`, the person, `boughtOn`, `totalMinor`, `refundedMinor`, `refundableMinor` (`totalMinor` minus refunds), `leftMinor` and `source`. `query` matches as a substring of the normalized item. At most 50, newest `boughtOn` first.
- `check_purchases`: for each input item, existing purchases of any person with the same `totalMinor` and a `boughtOn` within 3 days either way, with the person's name and the item.

### Write tools

| Tool | Parameters | Result |
| --- | --- | --- |
| `add_purchase` | `personId`, `item`, `price`, `boughtOn?` (today, or the due date or first due date when earlier), `plan?` (`once`), `dueDate?`, `count?` (6), `firstDue?`, `lastDayOfMonth?`, `note?` | The created purchase with its schedule and the person's new balance |
| `record_payment` | `personId`, `amount`, `paidOn?` (today), `note?` | The payment and the person's new balance |
| `add_refund` | `purchaseId`, `amount`, `refundedOn?` (today), `note?` | The refund and the purchase's new view |
| `add_alias` | `personId`, `alias` | The updated person |
| `remove_alias` | `personId`, `alias` | The updated person |
| `undo` | `recordId` | Confirmation of the deletion |

- `add_purchase`: `plan` is `once` or `installments`. For `once`, `dueDate` is a date or `payday`, `endOfMonth` or `inTwoWeeks`, default none. For `installments`, `count` defaults to 6 and `firstDue` defaults to `defaultInstallmentStart`; an explicit `firstDue` sets `dueDay` to its day, unless it is a month's last day and `lastDayOfMonth` is true, which sets `dueDay` to 31.
- `add_alias` and `remove_alias` change the person's `aliases` with an `update` operation, so the alias rules and `alias_conflict` apply. `remove_alias` matches by `normalizeName`. Their descriptions tell the agent to ask the buyer first.
- `undo` deletes a purchase, payment or refund with a normal delete operation (so `purchase_has_refunds` still applies), and only when `source` is `agent`, the record's `version` equals the ID of its create operation (unchanged since creation), and that operation's receipt `created_at` is within the last 24 hours. Otherwise it returns a tool error saying why.
- No tool records payouts, edits or deletes other records, creates, renames, archives or deletes people, changes settings or restores.
