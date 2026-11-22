# Family Tab: Tech Stack

Status — agreed, pending implementation

This document records the technology choices for the design in [DESIGN.md](DESIGN.md). It follows the conventions already used across the author's other repositories, mainly `sdash` (Go server with an embedded React PWA and OIDC sign-in) and `portfolio-tracker` (Go with SQLite, deployed to the homelab).

## 1. Summary

| Area | Choice |
| --- | --- |
| Server | Go, standard library `net/http`, single binary with the built frontend embedded |
| Storage | SQLite via `modernc.org/sqlite` and `sqlx` |
| Sign-in | `coreos/go-oidc/v3` and `golang.org/x/oauth2` against Authelia |
| Client | React, Vite, TypeScript, Tailwind CSS |
| Offline | Hand-written service worker, IndexedDB via `idb`, Web Locks, BroadcastChannel |
| Balance rules | Implemented in both TypeScript and Go, kept identical by shared fixtures and a differential test |
| Tests | `go test` with fuzzing, `node --test` or Vitest with `fast-check`, Playwright |
| Release | goreleaser, `ghcr.io/zekihan/distroless` image, Helm chart in `homelab`, Argo CD |

Node is used only as build and test tooling for the frontend. Nothing runs on Node in production.

## 2. Server

- **HTTP.** Standard library `net/http` and `ServeMux`. Serve the API and the embedded frontend from one origin, as `sdash/web/embed.go` does. Reuse `go-commons` for logging, panic recovery and health endpoints.
- **Database.** `modernc.org/sqlite` (pure Go, no cgo) with `sqlx`. Track schema versions with `PRAGMA user_version`, following `portfolio-tracker/internal/db`. Enable WAL and `foreign_keys`.
- **Writes.** Serialize writes through a single connection or mutex. Each operation, its receipt and the revision increment commit in one transaction (DESIGN.md section 7, Sync rule 4), and a single writer makes that ordering trivially correct.
- **Sessions.** Server-side session rows in SQLite, referenced by an opaque `Secure`, `HttpOnly`, `SameSite=Lax` cookie. Server-side storage is required so offline sign-out can revoke the session when the device reconnects. Do not use the Redis-backed `go-commons/session` package; this is a single instance.
- **OIDC.** `coreos/go-oidc/v3` and `golang.org/x/oauth2`, following `sdash/internal/server/{login,callback}.go`. Authorization code flow with PKCE `S256` and `query` response mode. The buyer is matched by `iss` and `sub`. Test with `oauth2-proxy/mockoidc`.
- **Time zones.** Import `time/tzdata` so IANA zones resolve inside the distroless image. All "today" checks use the ledger time zone.
- **Config.** Environment variables, parsed with `sethvargo/go-envconfig` as in `sdash`.

## 3. Client

- **Framework.** React, Vite, TypeScript and Tailwind CSS, matching `sdash/web`. Built into `web/dist` and embedded into the Go binary.
- **State.** A small store over the local ledger, read with `useSyncExternalStore`. No Redux or TanStack Query, because the client already holds the whole ledger locally.
- **Service worker.** Hand-written, in the style of `sdash/web/public/sw.js`. It caches the unauthenticated app shell only and never API responses. At startup with a connection it installs any new version before balances are computed (DESIGN.md section 7). Workbox and `vite-plugin-pwa` are avoided because this update rule needs direct control.
- **IndexedDB.** `idb`, a thin wrapper that keeps transactions explicit. The design relies on single transactions for writing an operation with the signed-out check, for sign-out purges and for snapshot saves.
- **Browser APIs.** Web Locks for the per-device sync lock and the restore lock, and BroadcastChannel for sign-out and restore broadcasts. Bottom sheets use a native `<dialog>`.
- **Dates.** A small in-house module for `YYYY-MM-DD` arithmetic: month clamping, adding days and months, comparison. `Intl.DateTimeFormat` resolves today's date in the ledger time zone. Dates are never held in JavaScript `Date` objects.
- **Numbers.** Amounts stay as integer kuruş everywhere. Display uses `font-variant-numeric: tabular-nums`.

## 4. Balance rules in two languages

The balance rules (DESIGN.md section 5) and validation rules (section 8) are implemented twice:

- **TypeScript** implements everything the client shows: schedules, refunds, allocation, Left to pay, Due by today, Behind plan, Due in the next month, Coming up, credit, cash shortfall, status chips, payment chips and amount parsing.
- **Go** implements what the server checks: schedules, refunds, net receipts and credit for payout checks, and the record and change validation rules.

Both are pure modules. They take records and an explicit `today` and do no I/O.

### Shared fixtures

- Fixtures live in `testdata/ledger/*.json`. Each one holds the records, a `today` date, the ledger time zone and the expected outputs.
- Seed the suite with the worked examples in DESIGN.md section 5 and every row of the Ledger cases and Parsing amounts tables in section 8.
- Each side asserts only the fields it implements. Go skips display-only fields such as Coming up and the chips.
- A bug fix in either implementation starts with a new fixture that reproduces it.

### Differential test

- A seeded generator produces random ledgers: people, purchases with both plans, refunds, payments, payouts, and dates around month ends and the `today` boundary.
- Both implementations compute outputs for every generated ledger, and the test fails on any difference in the fields they share.
- Any mismatch is saved as a new fixture so it becomes a permanent regression case.
- Run it in CI with a fixed seed set, and locally with a random seed.

## 5. Testing

- **Go.** `go test -race`, plus fuzz targets for amount parsing, validation and the sync commit path.
- **TypeScript.** `node --test` as in `sdash`, or Vitest. Use `fast-check` for properties such as "installments always sum to the total" and "allocation never exceeds net receipts".
- **End to end.** Playwright against the built binary with `mockoidc`, covering the offline cases in DESIGN.md section 7, Verification: network off and reload, undo after reload, payment retry, a crashed tab holding the sync lock, restore racing a write in another tab, and two browser contexts in different time zones.
- **Devices.** Manual checks of the installed PWA on iPhone Safari and Android Chrome.

## 6. Build and deployment

- **Build.** A Makefile and goreleaser, following `portfolio-tracker` and `sdash`. `make web` builds the frontend before the Go build.
- **Image.** `ghcr.io/zekihan/distroless`, non-root user, `/data` volume holding the SQLite database.
- **Cluster.** A Helm chart in `homelab/apps/family-tab`, deployed by Argo CD, on a Longhorn volume with the `hornkeeper` backup annotations used by `portfolio-tracker`.
- **Sign-in provider.** An Authelia OIDC client configured for PKCE `S256` and the `query` response mode, with the callback URL on the app's origin.
- **Database backup.** A Longhorn snapshot of a live SQLite file is not guaranteed to be consistent. Run a periodic `VACUUM INTO` to `/data/backups` (or use Litestream) so the snapshot always contains a restorable copy. This is the server database backup that DESIGN.md section 7 requires, separate from the buyer's JSON export.

## 7. Alternatives considered

| Option | Why not |
| --- | --- |
| TypeScript server sharing one ledger module | Removes the duplication, but puts Node on the backend and leaves the existing Go release tooling |
| Go compiled to WASM for the client | One copy of the logic, but a larger download, slower startup, and the cost of copying data in and out of WASM outweighs any speed gain for a ledger this small |
| Running the TypeScript module inside Go with `goja` | One copy of the logic, but harder to debug, and the module could not use `Intl` |
| Workbox or `vite-plugin-pwa` | Harder to enforce "install the new version before computing balances" |
