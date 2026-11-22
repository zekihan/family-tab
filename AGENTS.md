# AGENTS.md

Guidance for AI agents working in this repository.

## Documents

- `docs/DESIGN.md` — product and behavior design. The source of truth for rules.
- `docs/TECH_STACK.md` — technology choices.
- `docs/PROTOCOL.md` — wire types, API, backup file and fixture formats. Go
  (`internal/ledger/types.go`, `internal/protocol`) and TypeScript
  (`web/src/types.ts`) must match it exactly.

## Layout

| Path | Contents |
| --- | --- |
| `main.go` | Entry point: config, database, auth, sync service, HTTP server, backups |
| `internal/config` | Environment configuration |
| `internal/ledger` | Pure Go balance and validation rules (no I/O) |
| `internal/protocol` | Sync and backup wire types |
| `internal/store` | SQLite schema, migrations, ledger rows, receipts |
| `internal/syncsvc` | Operation commit path, snapshots, restore |
| `internal/auth` | OIDC sign-in, sessions, auth middleware |
| `internal/server` | HTTP routing, API handlers, SPA serving |
| `internal/backup` | Periodic `VACUUM INTO` database copies |
| `web/src/types.ts` | Shared TypeScript types |
| `web/src/ledger` | Pure TypeScript balance rules, dates, amount parsing |
| `web/src/data` | IndexedDB, operation queue, sync engine, sign-out, export and restore |
| `web/src/ui` | React screens |
| `web/public/sw.js` | Service worker (app shell only) |
| `testdata/` | Shared fixtures read by both Go and TypeScript tests |
| `web/difftest` | Differential test of the Go and TypeScript rules |
| `e2e/` | Playwright tests against the built binary and a mock OIDC provider |

## Commands

```sh
make web        # build the frontend into web/dist (embedded by the binary)
make test       # Go tests (with -race), web tests, differential test
make lint       # golangci-lint
make test/e2e   # Playwright
npm --prefix web test        # web unit tests (node --test, TypeScript via type stripping)
npm --prefix web run typecheck
```

TypeScript test files import sources with explicit `.ts` extensions and use
only erasable syntax (no enums, namespaces or parameter properties), so Node
runs them directly.

## Rules

- Amounts are integer kuruş everywhere. Dates are `YYYY-MM-DD` strings; never
  use JavaScript `Date` objects or Go `time.Time` for calendar dates.
- A bug fix in either balance implementation starts with a new fixture in
  `testdata/` that reproduces it.
