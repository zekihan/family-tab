# AGENTS.md

Guidance for AI agents working in this repository.

## Documents

- `docs/DESIGN.md` — product and behavior design. The source of truth for rules.
- `docs/TECH_STACK.md` — technology choices.
- `docs/DEPLOYMENT_MCP.md` — homelab configuration for agent access (MCP).
- `docs/PROTOCOL.md` — wire types, API, backup file and fixture formats. Go
  (`internal/ledger/types.go`, `internal/protocol`) and TypeScript
  (`web/src/types.ts`) must match it exactly.

## Layout

| Path | Contents |
| --- | --- |
| `main.go` | Entry point: config, database, auth, sync service, HTTP server, backups |
| `cmd/ledgercalc` | Go runner for the differential test |
| `internal/config` | Environment configuration |
| `internal/ledger` | Pure Go balance, view, defaults and validation rules (no I/O) |
| `internal/protocol` | Sync and backup wire types |
| `internal/store` | SQLite schema, migrations, ledger rows, receipts (store scaffold from go-commons `sqlitestore`) |
| `internal/syncsvc` | Operation commit path, snapshots, restore |
| `internal/mcp` | MCP server: agent tools over the ledger, mounted at `/mcp` |
| `internal/server` | HTTP routing, API handlers, SPA serving |
| go-commons `oidcauth` / `backup` | OIDC sign-in, sessions, bearer auth and periodic `VACUUM INTO` database copies (wired in `main.go`) |
| `web/src/types.ts` | Shared TypeScript types |
| `web/src/ledger` | Pure TypeScript balance rules, dates, amount parsing |
| `web/src/data` | IndexedDB, operation queue, sync engine, sign-out, export and restore |
| `web/src/ui` | React screens |
| `web/public/sw.js` | Service worker (app shell only) |
| `testdata/` | Shared fixtures read by both Go and TypeScript tests |
| `web/difftest` | Differential test of the Go and TypeScript rules |
| `e2e/` | Playwright tests and runner |
| `e2e/mockidp` | Mock OIDC provider used by Playwright |

## Commands

```sh
make web        # build the frontend into web/dist (embedded by the binary)
make test       # Go tests (including -race), web tests, differential test
make test/diff  # differential test only
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
