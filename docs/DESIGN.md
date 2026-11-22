# Family Tab: Design Doc

Status — confirmed design

Family Tab is a small personal app for the person who buys things online for the whole family. It records what each family member owes for the things bought for them and works out the balance automatically. A purchase is paid back either all at once or in monthly installments, and payments can come whenever the person has money.

## 1. Problem

- One person (the buyer) places most of the family's online orders: household goods, personal items, anything bought over the internet.
- Each purchase is for a specific family member, or for the household.
- Repayment varies:
  - **All at once**, usually around the person's payday.
  - **In installments**, matching how the buyer paid the store (for example 6 monthly card installments).
- Due dates are loose. People pay whenever they can, often partial amounts that don't match any one purchase.
- Today the buyer works out balances by memory or by hand. With overlapping installments and partial payments this goes wrong easily.

## 2. Goals and non-goals

Goals:

1. With an existing person and default dates, adding a purchase takes under 15 seconds and uses at most five fields before Save.
2. The buyer can correct any purchase, payment, shop refund or payout in place. Payments, payouts, shop refunds, and purchases without shop refunds can be deleted in one tap with undo.
3. For each person the app always answers "how much do they owe me in total?" and "how much of that is due by today?"
4. Partial payments and overpayments work at the person level. The ledger also accounts for shop refunds and cash returned to a family member.
5. Works on a phone, which is where purchases happen.
6. After initial SSO sign-in and download, the buyer can use the ledger offline. Changes sync to the server when a connection returns, and the buyer can open the same ledger on another device.

Non-goals (v1):

- Interest, late fees, or any form of lending money for profit.
- Real money movement, bank linking, or payment requests.
- Strict due-date enforcement, reminders that nag, or "late" shaming.
- Family accounts, shared access, and multi-user editing.
- Importing orders automatically from shops (see roadmap).

## 3. Users and use cases

| Who | Role | Main needs |
| --- | --- | --- |
| Buyer (owner) | Manages the ledger on their devices | Fast entry and correction, correct totals, history |
| Family member | Person repaying the buyer | Get their balance from the buyer |

User stories:

1. As the buyer, I just ordered a vacuum for Mom for 12,000 TL in 6 installments. I add it right after checkout.
2. As the buyer, I bought my sister shoes; she'll pay it back "on payday" or whenever she can.
3. Mom sends me 4,000 TL. I record it and the app spreads it over what she owes.
4. I entered a purchase twice. I delete one and the totals fix themselves.
5. At the start of the month I want to see how much is due from each person.
6. My sister asks "how much do I still owe you?" I show her balance from her person page.
7. The shop refunds part of Mom's vacuum after she has paid. I record the shop refund, then record a payout when I return some of her credit.

## 4. Core concepts and data model

```mermaid
erDiagram
    LEDGER ||--o{ PERSON : "contains"
    PERSON ||--o{ PURCHASE : "is bought for"
    PERSON ||--o{ PAYMENT : "pays back"
    PERSON ||--o{ PAYOUT : "receives cash back"
    PURCHASE ||--o{ REFUND : "has shop refunds"
    PURCHASE ||--|{ SCHEDULED_AMOUNT : "is split into (derived)"
    LEDGER {
        string timeZone "IANA name"
        string currency "TRY in v1"
        string generation "changes on restore"
        int revision "increments on each commit"
    }
    PERSON {
        string id
        string name
        int payday "day of month, optional"
        bool archived
    }
    PURCHASE {
        string id
        string personId
        string item
        int totalMinor
        date boughtOn
        enum plan "once | installments"
        date dueDate "optional, once only"
        int count "installments only"
        date firstDue "installments only"
        int dueDay "installments only, monthly anchor"
        string note "optional"
    }
    PAYMENT {
        string id
        string personId
        int amountMinor
        date paidOn
        string note "optional"
    }
    REFUND {
        string id
        string purchaseId
        int amountMinor
        date refundedOn
        string note "optional"
    }
    PAYOUT {
        string id
        string personId
        int amountMinor
        date paidOutOn
        string note "optional"
    }
    SCHEDULED_AMOUNT {
        string purchaseId
        int sequence "1 for a one-time purchase"
        int baseMinor
        int adjustedMinor "after shop refunds"
        date dueOn "optional for one-time purchases only"
    }
```

Key decisions:

- **One ledger per deployment.** The `LEDGER` record holds settings and sync metadata. Every stored record also carries a `version` used by sync (section 7). Scheduled amounts are derived and never stored.
- **The app derives a base schedule and an adjusted schedule.** The base schedule uses `totalMinor`, `count`, `firstDue` and `dueDay`. A one-time purchase produces a single scheduled amount with an optional date. The adjusted schedule accounts for shop refunds. The base schedule remains visible in purchase history.
- **Payments and payouts belong to a person.** A payment records money received from that person. A payout records money returned to them. A shop refund belongs to a purchase and can be recorded separately from any payout.
- **V1 uses TRY.** Store positive integer amounts in kuruş, capped per entry by the [validation rules](#validation-rules).
- **Household purchases** can use a regular person entry named "Household". The amount appears under Household and in Home totals and does not affect any individual's balance.
- **Dates are calendar dates** stored as `YYYY-MM-DD`. Store one ledger time zone, defaulting to the buyer's time zone at setup and editable in settings. All devices use it for today and date shortcuts. Changing it changes only what counts as today. Stored dates stay as they are. Purchase, payment, shop refund and payout dates can be backdated but cannot be in the future. Due dates and refund dates must be on or after the purchase date. Payday, when set, is a day from 1 through 31.

## 5. Balance rules

Compute balances from the current records whenever a record changes or the date changes in the ledger time zone. Changes to existing records can reallocate earlier payments.

1. **Build the schedule.** Each purchase creates one or more scheduled amounts.
   - All at once: one amount, with the optional due date or none ("whenever they can").
   - Installment *n* falls *n* − 1 months after the month of `firstDue`. Each date, including `firstDue`, uses `dueDay` clamped independently to that month's last day, so `firstDue` must equal `dueDay` clamped to its own month. Accept 2 to 120 installments, each worth at least one minor unit.
2. **Split evenly in minor units.** For installments, `base = floor(total / count)`. The remainder is spread one unit at a time over the first installments. 100.00 in 3 becomes 33.34, 33.33, 33.33, which always sums exactly to the total.
3. **Apply shop refunds.** Reduce the last installment first and work backward until the refund is exhausted. Keep the original amounts and due dates visible. Zeroed installments remain in the purchase history and contribute zero to the balance. A one-time purchase has only one amount to reduce. The total refunded for a purchase cannot exceed its price.
4. **Order dated amounts first.** Sort all dated amounts, including future ones, by due date. Then sort undated amounts by purchase date. Break ties by purchase date, purchase ID in lexicographic order, then installment sequence.
5. **Allocate net receipts.** Subtract payouts from payments received. If net receipts are positive, fill the adjusted scheduled amounts in order, allowing partial fills. If net receipts are negative, show their absolute value as a separate undated cash shortfall and use zero for allocation. Allocation ignores payment dates: a payment covers amounts by schedule order, even amounts added after it was received.
6. **Derive the numbers from the remaining amounts.**
   - **Left to pay** is the sum of unpaid purchase amounts and any cash shortfall.
   - **Due by today** is the unpaid part of dated amounts due on or before today.
   - **Behind plan** applies if a dated amount due before today is still unpaid. Use a calm amber status.
   - **Due in the next month** is the unpaid part of dated amounts due after today through the same day next month, clamped to month end. **Coming up** lists the first eight unpaid amounts in that window using the same sort order across all people.
   - **Payments received** and **Cash returned** show the gross totals for the two types of cash entries. **Credit** is the positive net receipts left after filling all purchase amounts. A person with credit has nothing left to pay. Credit automatically covers that person's later purchases.
   - Home totals are sums of each person's figures and include archived people, with a separate subtotal for archived balances. Credit stays with the person who paid it and never reduces another person's balance.

A new payout is limited to the person's credit. While any deletion that affects that person is pending undo, **Record cash returned** is unavailable for them, for at most seven seconds, so the client and server always check the same credit. If a later correction leaves net receipts negative, save the correction and show the cash shortfall. A payout already made offline can exceed available credit by the time it reaches the server. Hold it for review and let the buyer explicitly confirm it as money already returned.

```mermaid
flowchart LR
    P[Purchases and shop refunds] --> S[Adjusted schedule]
    S --> O[Dated amounts first]
    Y[Payments received less payouts] --> A[Allocate net receipts]
    O --> A
    A --> T[Total owed]
    A --> E[Due by today]
    A --> C[Credit]
```

Worked example, Mom (payday on the 15th):

| Purchase | Plan | Expected |
| --- | --- | --- |
| Robot vacuum, 12,000 TL | 6 × 2,000 TL from Sep 15 | Sep 15, Oct 15, Nov 15, Dec 15, Jan 15, Feb 15 |
| Kitchen towels, 349.50 TL | Once, no date | Bought Nov 18 |

Payments: 4,000 TL on Oct 16. On Nov 22:

- Sep and Oct installments are paid. Nov 15 (2,000 TL) is unpaid, so Due by today = 2,000 TL and Mom is Behind plan.
- Left to pay = 12,349.50 − 4,000 = 8,349.50 TL.
- Due in the next month (Nov 23 through Dec 22) = 2,000 TL for Dec 15.
- The towels are undated, so they count only toward Left to pay. They are filled after every dated installment, including Dec through Feb.

If a 600 TL purchase has three 200 TL installments and the shop refunds 150 TL, the adjusted schedule is 200, 200 and 50 TL. If a refund leaves 500 TL of credit and the buyer returns 300 TL, 200 TL of credit remains. If a correction changes payments received from 600 TL to 400 TL against 500 TL of payouts, net receipts fall from 100 TL to −100 TL. The 100 TL cash shortfall is undated and adds to Left to pay only. The 100 TL of receipts that previously covered scheduled amounts is also gone, so those amounts become unpaid again. If they were a 100 TL installment due today, Due by today rises from 0 to 100 TL and Left to pay rises by 200 TL.

## 6. Screens and flows

```mermaid
flowchart TD
    H[Home] -->|tap person| P[Person page]
    H -->|+ Add purchase| AP[Add purchase sheet]
    P -->|Record a payment| RP[Payment sheet]
    P -->|Add purchase| AP
    P -->|Edit a record or the person| E[Edit existing record]
    P -->|Record shop refund| F[Refund sheet]
    P -->|Record cash returned| C[Payout sheet]
    P -->|Archive person| A[Archive]
    P -->|Delete on a record| U[Deleted + Undo toast]
    AP -->|Save| R[Return to the opening screen]
    RP -->|Save| P
    H -->|Sync banner| RV[Review]
    H -->|Menu| S[Settings]
    S --> X[Time zone, export, restore, sign out]
```

### Home

- Headline: **Your family owes you X**, the sum of Left to pay across all people. Show total credit held separately when positive.
- Two figures show **Due by today** and **Due in the next month**.
- One row per active person shows their name, amount left and a status chip. Sort rows by Due by today, then Left to pay, both descending, then name. In order, show credit if positive, "All paid" if nothing is left, the amount due by today if positive, the earliest unpaid future date if any, or "When they can". Include "Behind plan" in the chip when the person meets that rule.
- Show the archived balance subtotal and link to the archive. Home totals and Coming up include archived people, with an archive label on their upcoming entries.
- **Coming up** shows the person, item, date and remaining amount for each entry in the upcoming list.
- Show sync status when changes are pending, the app is offline, or the buyer needs to sign in or resolve a conflict. Locally saved changes appear in balances immediately. Operations held for review do not count in balances until the buyer resolves them. The Home menu offers **Sync now**.
- A fixed bottom bar keeps **+ Add purchase** within reach.

### Add purchase (the most important flow)

Bottom sheet, one screen, no wizard:

1. **Who** – chips of active people (preselected if opened from an active person's page or there is only one active person), plus "+ New person" inline.
2. **What** – free text ("Vacuum cleaner").
3. **Total price** – numeric keyboard. Accepts both `1.250,50` and `1,250.50` under the amount parsing rules below.
4. **How they pay back** – segmented control:
   - *All at once* (default) has an optional date. Chips include No fixed date (default), Their payday (when set; the first payday on or after today), End of month (the current month's last day) and In 2 weeks (today plus 14 days). A custom date can also be entered.
   - *In installments* offers count chips 2 / 3 / 4 / 6 / 9 / 12 / other, with 6 selected initially. The first due date defaults to the first payday on or after today, or one calendar month from today if payday is unset.

Below the count chips, the live preview shows the count, first and last dates, and amount or range of amounts. Use "6 × 2.000 TL" when all six amounts are equal. Tapping the first date opens the calendar picker.

Purchase date (default today) and note are secondary optional fields that stay collapsed until opened. Who, what and price are required. Date shortcuts use today in the ledger time zone, even for a backdated purchase. Payday resolves to the chosen day clamped to the last day of each candidate month. The installment default keeps the payday as its monthly anchor, or today's day when payday is unset. Selecting a custom first due date uses its day as the anchor. Choosing a month's last day also offers "last day of each month", stored as anchor 31, and confirming the default date keeps the default anchor. If a chosen due date falls before a purchase date the buyer has not changed, move the purchase date back to it and show that. If the buyer sets a purchase date later than the due date, block Save. Save the resolved dates and anchor on the purchase so changing someone's payday only changes defaults for new entries.

A payday change synced from another device leaves the selected shortcut date and the active installment default in place. Changing the person recalculates the selected shortcut and any unsaved installment default. Switching to installments uses the current default and keeps a first date the buyer already set. An edit keeps the saved installment anchor unless the buyer picks a different first due date or toggles the last-day option.

### Person page

- Show **Due by today**, **Left to pay**, **Payments received**, **Cash returned**, and any positive **Credit**. Itemize any cash shortfall under Left to pay.
- Offer **Record a payment** as the primary action. Offer **Add purchase** for active people and **Record cash returned** when there is credit and no pending-undo deletion affects them. **Edit person** changes the name and payday; payday changes affect only defaults for new purchases.
- Purchases appear newest first. Each card shows the item, original total, refunds, plan, progress, amount left and earliest unpaid dated amount. Installment progress counts only installments with a positive amount after refunds. Show fully refunded installments separately. **Show dates** includes both schedules. The card offers Edit, Delete and Record shop refund where applicable.
- Show incoming payments and payouts in dated history, newest first. Offer Edit and Delete on both.
- **Archive person** explains any outstanding balance before confirmation and preserves their records. The archive allows payments, shop refunds, and payouts. Unarchive the person before adding a purchase to their ledger or moving one to it. A person with no records shows only **Delete person** in place of the archive or unarchive action. That deletion is permanent and has the usual undo window.

### Record a payment

- Quick chips fill the amount with **Due by today**, **Through next due date** (Due by today plus every unpaid amount due on the earliest due date after today, so it actually covers that date under the allocation order) or **Everything** (all left to pay). When there is a cash shortfall, the first receipts cover it, so **Due by today** and **Through next due date** add the shortfall and show that breakdown. Show chips for valid positive payment amounts and default to the first chip with a positive amount. Each chip sets the payment amount and uses the usual allocation order.
- Date (today) and optional note ("cash", "bank transfer").
- Hint — "Payments first cover any cash shortfall, then dated amounts starting with the earliest due, then purchases without a date. Anything left becomes credit."

### Corrections and refunds

- Open any existing record in its form to edit it. Keep its ID and recompute balances for everyone affected when the edit is saved. Editing a purchase's person moves it, with its shop refunds, to another active person's ledger. Payments and payouts can also be moved to another person. A moved payout is checked in full against the destination person's credit.
- Record a shop refund from its purchase with an amount, date and optional note. Show refunds in purchase history and offer correction or removal there. Removing a refund uses the same one-tap delete with undo. Block changes that would leave refunds above the purchase total or before the purchase date. Review and remove linked shop refunds before deleting the purchase.
- Record cash returned from the person's page with an amount, date and optional note. Show the available credit before saving. Allow corrections to payout records and check available credit against any increase. Recording the shop refund and recording the cash payout are separate actions.
- Delete payments, payouts, shop refunds, and purchases without shop refunds in one tap. Apply the deletion locally and hold the queued operation for seven seconds. **Undo** cancels it and restores the records with their original IDs. Undoing a deletion also restores any linked purchase or person whose deletion is still pending. After a reload, offer Undo for the time remaining on the saved deadline.

### Review

- The Home sync banner opens Review when any operation needs review. Review lists each held operation with its reason, the local and server versions or the blocking records, the related operations waiting behind it, and the actions from [Sync](#sync) rule 6. Restore review uses the same screen.

### Settings

- Reached from a Home menu. Holds the ledger time zone, Export, Restore, and Sign out, each following section 7.

### Visual language

- Calm colours. Green for paid, amber for expected or behind plan. No red "late" for family members.
- Large, tabular-figure numbers; amounts are the content.
- Light and dark themes.
- Show dates day first. Date fields use DD.MM.YYYY, also accept YYYY-MM-DD, and offer a calendar picker.

## 7. Platform and technical approach

### PWA and server

- Self-host the PWA and API together over HTTPS on the same origin. The server authorizes every ledger read and write for the single configured buyer and stores the synced ledger in SQLite on persistent storage.
- A service worker caches only the unauthenticated app shell, never API responses. At startup, use the cached shell if the network cannot supply a matching shell in time. Use a new version if it is ready before the startup window closes. Otherwise use it on the next startup. The open ledger never reloads for an update. An update needs a complete set of app files before it can be installed. IndexedDB stores the last synced ledger and a queue of pending operations, scoped to the buyer. After setup the buyer can reopen the app, work with the ledger, and undo deletions while offline.
- Balance logic lives in a pure, framework-free module that takes the records and an explicit `today` date. The app computes balances from the last synced records plus pending local changes. The server stores records and sync metadata. It validates writes before committing them.

### Sign-in

- **Sign in with SSO** is the only sign-in action. Use one configurable OpenID Connect (OIDC) provider per deployment and delegate account and credential management to that provider. Allow access only to the configured buyer identity, identified by the verified issuer (`iss`) and subject (`sub`) pair. [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability)
- The server handles the OIDC authorization code flow with PKCE (`S256`). Each sign-in attempt stores a one-time transaction on the server with `state`, `nonce` and the PKCE verifier. The browser holds only a random value that identifies it, in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie that lasts ten minutes and is scoped to the callback path; the server keeps only a hash of that value. Use the `query` response mode so the callback is a top-level GET that carries that cookie. The callback must match that transaction, which is then consumed. Validate the ID token per OIDC Core, including a signature using an allowlisted algorithm (never `none`), `iss`, `aud` (this client), `azp` when present, `exp`, `iat` and `nonce`, before checking the buyer's `iss` and `sub`. Then issue a fresh server session in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie. The session lasts 30 days and renews while the app is in use. Discard provider tokens once the server session exists. The session does not need them. Every API request, reads included, must carry a custom request header, so a cross-site request or a plain navigation to the API cannot read or change the ledger. Do not enable credentialed CORS. [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth), [OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1)
- Initial sign-in and download require a connection. If the server session expires, keep the cached ledger and pending operations available until sign-out. Resume sync only after the same buyer signs back in through SSO.
- Sign-out clears the local ledger and pending operations across tabs on that device. If there are pending changes, warn the buyer and require confirmation before discarding them. When connected, offer to sync first. When offline, keep only a local marker for pending server sign-out. Write that marker and purge the ledger, the queue and any saved drafts in one IndexedDB transaction, then broadcast sign-out to other tabs. Every tab checks the signed-out state before rendering ledger data or persisting an operation, so a suspended tab that wakes discards its in-memory ledger and unsaved forms instead of writing them. Until the marker clears, reconnecting only revokes the old server session. Clear the marker once the server confirms the session is gone, including when it was already expired or missing. Retry only after a network failure. Complete that sign-out before starting a new session or loading ledger data.

### Sync

1. **Local writes.** Persist each operation in IndexedDB before showing its effect, in the same transaction that checks the signed-out marker, so a purge and a write can never both commit. Generate stable IDs for records and operations on the client. Operations are creates, deletions, or field-level patches of a single record. A deletion stores the full pre-image of every record it removes, so Undo works after a reload. An edit form records the ledger generation and the record version when it opens. The save checks both in the same transaction. If either changed, the form does not save over the record and shows the current version so the buyer can reapply their change.
2. **Two held states.** *Pending undo* is a deletion inside its seven-second window: applied locally, counted in balances, not yet sent. *Needs review* is an operation the server did not accept: shown in the review view and excluded from balances until the buyer resolves it.
3. **Order.** Send operations in queue order within each group of related work. Operations are related when they touch the same record, or change the schedule or net receipts of the same person. Refunds belong to their purchase's person. A purchase, payment or payout that moves between people belongs to both the old and the new person. Creating a person comes before any operation on their ledger. Archiving a person keeps its place in queue order. Operations for unrelated people sync independently. A pending-undo deletion holds back later related operations until its deadline.
4. **Commit.** The server holds, without applying, any uncommitted operation whose generation differs from the current one, and the client sends it to restore review. Each operation carries the ledger generation and, for updates and deletions, the record version it was based on. The record version is the ID of the last operation that changed it. The server validates the operation against the [validation rules](#validation-rules) and the current records, applies it, and stores a receipt with its ID, result, generation and revision, all in one transaction. Receipts live outside the ledger rows, so a restore does not erase them. A retry of a committed operation returns its original receipt. A deterministic rejection is also stored as a receipt and is never retried automatically.
5. **Cycle.** Run one sync cycle at a time per device, using a lock that is released if its tab crashes or closes, such as the Web Locks API. Sync after a local change, at startup, on returning to the foreground, when the connection returns, and on manual request. While open and connected, refresh every 30 seconds. Each cycle:
   1. Sends the IDs of queued operations and receives receipts for any already committed or rejected, together with the current generation. If the generation changed, move queued operations to restore review before sending anything.
   2. Sends the remaining operations in order.
   3. Fetches a full snapshot with its generation, revision and record versions.
   4. In one local transaction, saves the snapshot and removes every acknowledged operation whose receipt generation equals the snapshot's and whose revision is at most the snapshot's. If the revision is newer, fetch again.
   5. Rebuilds the local view by replaying the remaining sendable and pending-undo operations over the snapshot. Operations that need review, and the related operations waiting behind them, are left out of the local ledger and its balances and appear only in Review.
6. **Review.** An operation needs review when it conflicts with a newer version of the same record, including a deletion against an edit; when the server rejects it for a validation rule, with the server's reason and the blocking records; or when a payout no longer fits the person's credit. For a conflict the buyer keeps the server version or the local one. For a rejection they edit and resubmit or discard. For a payout they confirm that the cash was already returned, which resubmits it with an `alreadyReturned` flag that lets the server accept it above available credit. Balances are then computed normally, and a cash shortfall appears only if net receipts become negative. Every resubmission uses a new operation ID and, as its base, the record version the buyer just reviewed. Keeping a local edit of a record that another device deleted recreates the record with its original ID and goes through normal validation. Later related operations wait with the held one and are never rebased automatically. After the buyer resolves it they are sent again, and any that now fail come back to review with their own reason.
7. **After a restore.** Compare generations only for equality. An operation created against, or committed in, a generation other than the current one is dropped when the snapshot already reflects it: a create or update when the record has the intended content, a deletion when the record is absent. This happens when the restored backup already included it. Otherwise it goes to restore review, where reapplying keeps the original record ID and uses the current record version as its base.
8. **Sign-out.** After sign-out, discard any in-flight results from the signed-out session.

### Backup and restore

- **Export** a versioned JSON file with TRY, the ledger time zone, people, purchases, payments, shop refunds and payouts. Include pending changes reflected in the local ledger and allow export offline. Pending-undo deletions are exported as applied. List operations that need review in a separate unapplied section, with their kind, target ID, payload or pre-image, base version, generation, order and dependencies, and keep them available for review until resolved. Back up the server database separately for recovery after server data loss.
- **Restore** requires a connection and an empty local queue. Validate the backup, preview what will be replaced, and ask for confirmation. Preview without a lock. At confirmation, take the cross-tab sync lock, recheck that the queue is empty and the revision still matches, and commit. While the lock is held, other tabs show a "Restore in progress" state and block Save. When the restore finishes or fails, or its tab closes, release the lock and broadcast so every tab reloads or returns to normal. The restore carries an operation ID. The server first looks up its receipt, stored outside the ledger rows, and returns it if the restore already committed. Otherwise it replaces the ledger in one transaction only if the revision still matches the preview, and gives the restored ledger a new generation and a revision one greater than the preview's. After a successful restore, refresh the local copy from the server. If the restore times out, check its result automatically. The buyer can retry or cancel it in Settings. Validation or write failures leave the ledger intact.
- Give the restored ledger a new generation. Operations from another device that were queued against the previous generation are held for the buyer to review against the restored ledger. For each one the buyer can discard it, or apply it as a new operation against the restored ledger, which goes through normal validation and conflict checks. On the device that restored the backup, operations in its unapplied section enter the same review, in their original order and with their dependencies, unless the restored ledger already reflects them, as defined in [Sync](#sync) rule 7.

### Verification

- Test scheduling, allocation, refunds, payouts, archive totals, amount parsing and backup validation. Verify that devices in different time zones agree on the due date boundaries.
- Test the installed PWA on iPhone via Safari and Android via Chrome, and verify desktop browser access. After online setup, disable the network, make changes, reload, and reconnect. Check undo after reload, payment retry, refresh on another device, independent sync during a conflict, payout confirmation, related operations held behind a conflict, held validation failures, a crashed tab holding the sync lock, restoring an export whose changes are still queued on another device, restore racing with a write in another tab, and recovery of stale edits after a backup restore.
- Verify that only the configured SSO identity can access the ledger, that an expired session preserves offline changes, and that a confirmed offline sign-out clears local data and ends the server session when the app reconnects.

## 8. Edge cases

### Validation rules

The client checks these on save, and the server checks them on every operation. "Today" and "the future" always mean the calendar date in the stored ledger time zone, whatever the server's own time zone.

Record rules, also checked on every record in a restore:

- The ledger time zone is a valid IANA name and the currency is TRY. Person names and purchase items are non-empty after trimming. Payday, when set, is from 1 through 31.
- Amounts are positive whole kuruş, at most 100,000,000 TL per entry. At that cap, totals stay within JavaScript's safe integers for any realistic ledger.
- New or changed purchase, payment, refund and payout dates cannot be in the future. Restore checks every such date. Due dates and refund dates are on or after the purchase date.
- A one-time purchase has no installment fields. An installment purchase has a count from 2 to 120, each installment at least one kuruş, and `firstDue` equal to `dueDay` clamped to its month.
- A purchase's refunds sum to at most its price.
- Purchases, payments, payouts and refunds reference existing records.
- IDs are unique.

Change rules, checked only on operations and never against restored records, so a restored archived person's purchases and a restored payout that leaves a cash shortfall stay valid:

- A new or moved purchase belongs to an active person.
- A purchase with refunds cannot be deleted.
- A payout that is new, increased or moved fits the destination person's credit computed without that payout, unless the operation carries `alreadyReturned`.
- A person can be deleted only when no purchase, payment or payout references them at commit time.

### Parsing amounts

Purchase, payment, refund and payout fields use the same rules. Trim surrounding whitespace and accept positive values using digits, `.` and `,`, with at least one digit before any decimal separator and one or two digits after it. When both separators appear, the decimal separator is the one that occurs once and after every occurrence of the other, which must form valid thousands groups. Any other mix is rejected. A repeated separator must form valid thousands groups. For a single separator, prefer decimal when the fraction fits within two digits. Otherwise accept it as a thousands separator if the grouping is valid. A valid grouping starts with one to three digits, not starting with zero, followed by groups of exactly three. Reject amounts above the per-entry cap. Reject malformed values and excess fractional digits. Convert the digits directly to integer kuruş. Show the interpreted TRY amount before Save.

### Ledger cases

| Case | Behaviour |
| --- | --- |
| Installment day 31 with a first payday in February | February uses its last day and March uses the 31st |
| Total not divisible by count | Remainder spread over the first installments, sum stays exact |
| Purchase amount below the installment count in minor units | Reject the plan and ask for a smaller count |
| Unpaid installment due today | Included in Due by today and excluded from Behind plan and Due in the next month |
| Payment larger than everything owed | Shown as credit, applied to future purchases |
| Payment deleted | Recompute balances. Installments previously shown as paid may become unpaid again |
| Purchase deleted after partial payment | Reallocate the payment in dated-first order. Any excess becomes credit |
| Undated one-time purchase | Included in Left to pay and excluded from date-based totals |
| Purchase fully refunded after receiving a payment | The adjusted balance for the purchase is zero. Reallocate net receipts and show any excess as credit |
| Person archived while they still owe money | Keep their balance in Home totals and show it in the archive subtotal |
| `1.500` in a TRY ledger | Parsed as 1,500 TL and shown in the ledger's currency format |
| `12,50.00` in a TRY ledger | Rejected because the thousands group has two digits |
| `1.234,56,78` or `0.500` | Rejected: the decimal separator repeats, or a thousands group follows a leading zero |
| `1,5` or `1.5` | Parsed as 1.50 TL |
| `0`, `,50`, `12,` or `1.234,567` | Rejected as zero, missing an integer digit, missing fraction digits, or too many fractional digits |
| Installment purchase with a custom first due date | The date's day becomes `dueDay`, unless the buyer picks "last day of each month" |
| Backdated installment plan entered today | The purchase date moves back to the first due date unless the buyer set it |

## 9. Later release design

### Split purchases

- Record one purchase and one schedule, with a share for each person. Default to equal shares and let the buyer enter exact amounts. Require the shares to add up to the price and distribute any remainder from an equal split in stable person ID order.
- Split the base schedule in integer kuruş. Across each installment the shares must sum to the original installment amount. Across all installments each person's amounts must sum to their agreed share. Round each installment's proportional allocation down. Then walk installments in sequence and give each residual kuruş, one at a time, to the person with the lowest ID who still needs units both in that installment and toward their share.
- For example, split a 100 TL purchase equally between two people over three months. The installment totals are 33.34, 33.33 and 33.33 TL. One person can owe 16.67, 16.67 and 16.66 TL, while the other owes 16.67, 16.66 and 16.67 TL. Both owe exactly 50 TL.
- For a shop refund, default to a proportional split using the original shares and cap each person's refund at their remaining refundable amount. Allocate any remainder deterministically among shares with capacity. The buyer can provide exact amounts when a return was for just one person. Reduce the latest amounts first within each affected share and preserve the original schedule.

### Targeted payments

- A payment can target a purchase or the payer's own share of a shared purchase. Allocate targeted payments before general payments. Within a target, use the usual dated-first order. Add any excess to the general pool and then apply the usual allocation rules to all remaining amounts.
- Cap all allocation at the person's positive net receipts. Where payouts reduce that pool, use general receipts first to cover the payouts, then reduce the amounts available from targeted payments, newest first. Process multiple targeted payments in payment-date order, then by payment ID.
- Recompute allocations after a correction, refund, or newly targeted payment. If a target is removed or an edited split removes the payer's share, keep the payment on the person's ledger and treat it as a general payment. Any remaining excess becomes credit.

### Shareable summary

- The buyer previews a plain-text snapshot for one person and shares or copies it. Include Left to pay, Due by today, next unpaid future due date if present, and the as-of date in the ledger time zone. The recipient receives a fixed snapshot. Family Tab sign-in remains available to the buyer only.

### Monthly summary

- The buyer can opt in to an in-app monthly summary and choose a day from 1 through 31 in the ledger time zone. Clamp the day to the last day in shorter months.
- On or after that day, show the buyer the current due amounts and what remains scheduled through the end of the month. If they open the app later that month, show the summary then. Keep it visible until dismissed and apply dismissal to that ledger month across the buyer's devices through a synced dismissal record. The next eligible month gets its own summary.

The later receipt and import work can revisit whether to store the shop's card schedule separately from the family repayment schedule.

## 10. Roadmap

| Phase | Scope |
| --- | --- |
| v1 – MVP | TRY ledger, purchases and payments with in-place edits, refunds and payouts, dated-first balances, archive, delete + undo, offline PWA, SSO-only sign-in, self-hosted cross-device sync, JSON backup |
| v2 | Split purchases between people, target payments to a purchase, search and filter |
| v3 | Shareable plain-text snapshots and the buyer's optional in-app monthly summary |
| Later | Attach the order screenshot or receipt, import from shop order emails, statistics (spending per person per month) |
