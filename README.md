# Family Tab

A small self-hosted app for the person who buys things online for the whole
family. It records what each family member owes for purchases made for them,
in one go or in monthly installments, and works out balances automatically.
It is an offline-capable PWA that syncs to a single Go server and signs in
with one OIDC provider.

See [docs/DESIGN.md](docs/DESIGN.md) for the design and
[docs/TECH_STACK.md](docs/TECH_STACK.md) for the stack.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | required | External origin, used for the OIDC callback URL `<PUBLIC_URL>/auth/callback` |
| `OIDC_ISSUER` | required | Provider issuer URL |
| `OIDC_CLIENT_ID` | required | Client ID |
| `OIDC_CLIENT_SECRET` | empty | Client secret, if the client is confidential |
| `BUYER_SUBJECT` | required | `sub` of the only identity allowed in |
| `MCP_CLIENT_ID` | empty | OAuth client whose access tokens may call `/mcp`; MCP is disabled when empty |
| `MCP_AUDIENCE` | `PUBLIC_URL` + `/mcp` | Resource identifier MCP access tokens must name in `aud` |
| `LISTEN_ADDR` | `:8080` | HTTP listen address |
| `DB_PATH` | `./family-tab.db` | SQLite database |
| `BACKUP_DIR` | empty | Directory for periodic `VACUUM INTO` copies; disabled when empty |
| `BACKUP_INTERVAL` | `6h` | Time between database copies |
| `BACKUP_KEEP` | `28` | Number of database copies to keep |
| `LOG_LEVEL` | `INFO` | Log level |
| `COOKIE_INSECURE` | `false` | Drop the `Secure` cookie attribute, for local HTTP development only |

The OIDC client must allow PKCE `S256` and the `query` response mode. The container image sets `DB_PATH=/data/family-tab.db` and `BACKUP_DIR=/data/backups`.

## Development

```sh
make web        # build the frontend
make dev        # build the frontend and run the server
make test       # Go, web and differential tests
make test/diff  # compare the Go and TypeScript ledger rules
make test/e2e   # Playwright against the built server and mock OIDC provider
```
