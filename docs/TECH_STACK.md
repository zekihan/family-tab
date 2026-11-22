# Family Tab: Tech Stack

Status — implemented stack

This document records the technology choices for the design in [DESIGN.md](DESIGN.md). It follows the conventions already used across the author's other repositories, mainly `sdash` (Go server with an embedded React PWA and OIDC sign-in) and `portfolio-tracker` (Go with SQLite, deployed to the homelab).

## 1. Summary

| Area | Choice |
| --- | --- |
| Server | Go, standard library `net/http`, single binary with the built frontend embedded |
| Storage | SQLite via `modernc.org/sqlite` and `sqlx` |
| Sign-in | `coreos/go-oidc/v3` and `golang.org/x/oauth2` against a configurable OIDC provider |
| Agent access | MCP over streamable HTTP with `github.com/modelcontextprotocol/go-sdk`, Authelia JWT access tokens |
| Client | React, Vite, TypeScript, Tailwind CSS |
| Offline | Hand-written service worker, IndexedDB via `idb`, Web Locks, BroadcastChannel |
| Balance rules | Implemented in both TypeScript and Go (schedules, view, add-purchase defaults, name normalization), kept identical by shared fixtures and a differential test |
| Tests | `go test` with fuzzing, `node --test` with `fast-check`, Playwright |
| Release | goreleaser, `ghcr.io/zekihan/distroless` image, Helm chart in `homelab`, Argo CD |

Node is used only as build and test tooling for the frontend. Nothing runs on Node in production.

## 2. Server

- **HTTP.** Standard library `net/http` and `ServeMux`. Serve the API and the embedded frontend from one origin, as `sdash/web/embed.go` does. Reuse `go-commons` for logging, panic recovery and health endpoints.
- **Database.** `modernc.org/sqlite` (pure Go, no cgo) with `sqlx`. Track schema versions with `PRAGMA user_version`, following `portfolio-tracker/internal/db`. Enable WAL and `foreign_keys`.
- **Writes.** One SQLite connection serializes transactions. An applied operation, its receipt and the revision increment commit in one transaction (DESIGN.md section 7, Sync rule 4).
- **Sessions.** Server-side session rows in SQLite, referenced by an opaque `Secure`, `HttpOnly`, `SameSite=Lax` cookie. Server-side storage is required so offline sign-out can revoke the session when the device reconnects. Do not use the Redis-backed `go-commons/session` package; this is a single instance.
- **OIDC.** `coreos/go-oidc/v3` and `golang.org/x/oauth2`, following `sdash/internal/server/{login,callback}.go`. Authorization code flow with PKCE `S256` and `query` response mode. The buyer is matched by `iss` and `sub`. The `ft_oidc_tx` cookie is `Secure` by default, `HttpOnly` and `SameSite=Lax`. It expires after 10 minutes and is scoped to `/auth/callback`. SQLite stores its token hash with the state, nonce and PKCE verifier. The callback consumes the row and checks the state, then verifies the ID token signature against an algorithm allowlist. It also checks the issuer, audience, expiration, issued-at time and nonce. If present, the authorized party must match the client ID. It is required for tokens with multiple audiences. Tests use `oauth2-proxy/mockoidc`.
- **MCP.** `internal/mcp` uses the official `github.com/modelcontextprotocol/go-sdk` with the streamable HTTP transport, mounted at `/mcp` on the same origin and stateless where the SDK allows. Tools commit through the same `syncsvc` path as the PWA. It is enabled only when `MCP_CLIENT_ID` is set.
- **MCP tokens.** The agent's client (Claude) signs in at the existing OIDC issuer, Authelia, and sends a JWT access token as a bearer token. The server verifies it with a `go-oidc` remote key set from the issuer's discovery document: `RS256` only, issuer, audience, expiry, client ID and the buyer's `iss` and `sub`. Cookie sessions and bearer tokens are not interchangeable between `/api` and `/mcp`. Details are in PROTOCOL.md section 5.
- **Time zones.** Import `time/tzdata` so IANA zones resolve inside the distroless image. All "today" checks use the ledger time zone.
- **Config.** Environment variables, parsed with `sethvargo/go-envconfig/v2`.

## 3. Client

- **Framework.** React, Vite, TypeScript and Tailwind CSS, matching `sdash/web`. Built into `web/dist` and embedded into the Go binary.
- **State.** A small store over the local ledger, read with `useSyncExternalStore`. No Redux or TanStack Query, because the client already holds the whole ledger locally.
- **Service worker.** Hand-written, in the style of `sdash/web/public/sw.js`. It caches the unauthenticated app shell only and never API responses. Navigation gives the network up to 3 seconds to return a successful, complete HTML shell for the active build, then falls back to the cached shell if needed. The 5-second startup budget includes navigation, update discovery, installation and activation. Installation requires every precached file to have a complete, successful response of the expected type. The app only requests activation and reloads during startup. Updates that are still installing when the window closes wait for the next startup. If activation was already requested, it can finish without a reload. Workbox and `vite-plugin-pwa` are avoided because this update rule needs direct control.
- **IndexedDB.** `idb`, a thin wrapper that keeps transactions explicit. The design relies on single transactions for writing an operation with the signed-out check, for sign-out purges and for snapshot saves.
- **Browser APIs.** Web Locks for the per-device sync lock and the restore lock, and BroadcastChannel for sign-out and restore broadcasts. Bottom sheets use a native `<dialog>`.
- **Dates.** A small in-house module for `YYYY-MM-DD` arithmetic: month clamping, adding days and months, comparison. `Intl.DateTimeFormat` resolves today's date in the ledger time zone. Dates are never held in JavaScript `Date` objects.
- **Numbers.** Amounts stay as integer kuruş everywhere. Display uses `font-variant-numeric: tabular-nums`.

## 4. Balance rules in two languages

The balance rules (DESIGN.md section 5) and validation rules (section 8) are implemented twice:

- **TypeScript** implements everything the client shows: schedules, refunds, allocation, Left to pay, Due by today, Behind plan, Due in the next month, Coming up, credit, cash shortfall, status chips, payment chips, home order, amount parsing and the add-purchase date defaults.
- **Go** implements what the server checks and what the MCP tools report: schedules, refunds, net receipts and credit for payout checks, the record and change validation rules, and a port of the ledger view (balances, home totals, Coming up, chips, payment chips, purchase views), the add-purchase date defaults and name normalization. Only home order, which needs locale collation, stays TypeScript only.

Both are pure modules. They take records and an explicit `today` and do no I/O.

### Shared fixtures

- Fixtures live in `testdata/ledger/*.json`. Each one holds the records, a `today` date, the ledger time zone and the expected outputs.
- Seed the suite with the worked examples in DESIGN.md section 5 and every row of the Ledger cases and Parsing amounts tables in section 8.
- Go asserts every `expect` key except `homeOrder`. `testdata/names.json` and `testdata/defaults.json` cover name normalization and the add-purchase defaults on both sides.
- A bug fix in either implementation starts with a new fixture that reproduces it.

### Differential test

- The test in `web/difftest` uses a seeded generator and runs the Go rules through `cmd/ledgercalc`. It generates people, purchases with both plans, refunds, payments, payouts, and dates around month ends and the `today` boundary.
- Both implementations compute the full ledger view (minus home order) for every generated ledger, and the test fails on any difference.
- Any mismatch is saved as a new fixture so it becomes a permanent regression case.
- `make test/diff` runs the fixed seed set by default, including in CI. Set `DIFF_SEED` to an integer or `random` to run one seed.

## 5. Testing

- **Go.** `go test -race`, plus fuzz targets for amount parsing, validation and the sync commit path.
- **TypeScript.** `node --test` with TypeScript type stripping. Use `fast-check` for properties such as "installments always sum to the total" and "allocation never exceeds net receipts".
- **End to end.** `make test/e2e` runs Playwright via `e2e/run.sh` against the built binary and the mock OIDC provider in `e2e/mockidp`. It covers offline reload, undo after reload, payment retry, closing a tab that holds the sync lock, blocking saves in other tabs during a restore, and two browser contexts in different time zones.
- **Devices.** Manual checks of the installed PWA on iPhone Safari and Android Chrome.

## 6. Build and deployment

- **Build.** A Makefile and goreleaser, following `portfolio-tracker` and `sdash`. `make web` builds the embedded frontend. `make dev` and `make build` build it before running or packaging the server.
- **Image.** `ghcr.io/zekihan/distroless`, non-root user, `/data` volume holding the SQLite database.
- **Cluster.** The Helm chart belongs in the separate `homelab` repository. Deploy it through Argo CD on a Longhorn volume with the `hornkeeper` backup annotations used by `portfolio-tracker`.
- **Sign-in provider.** Configure the OIDC client for PKCE `S256` and the `query` response mode, with the callback URL on the app's origin. Authelia is the homelab provider. Agent access needs a second Authelia client; see [DEPLOYMENT_MCP.md](DEPLOYMENT_MCP.md).
- **Database backup.** A Longhorn snapshot of a live SQLite file is not guaranteed to be consistent. The server runs `VACUUM INTO` at startup and every `BACKUP_INTERVAL` when `BACKUP_DIR` is set. It keeps the newest `BACKUP_KEEP` copies. The defaults are 6 hours and 28 copies. The image sets `BACKUP_DIR=/data/backups`. This is the server database backup that DESIGN.md section 7 requires, separate from the buyer's JSON export.

## 7. Alternatives considered

| Option | Why not |
| --- | --- |
| TypeScript server sharing one ledger module | Removes the duplication, but puts Node on the backend and leaves the existing Go release tooling |
| Go compiled to WASM for the client | One copy of the logic, but a larger download, slower startup, and the cost of copying data in and out of WASM outweighs any speed gain for a ledger this small |
| Running the TypeScript module inside Go with `goja` | One copy of the logic, but harder to debug, and the module could not use `Intl` |
| Workbox or `vite-plugin-pwa` | Harder to enforce the startup update window and check that shell files match the build |
