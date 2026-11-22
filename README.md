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
| `LISTEN_ADDR` | `:8080` | HTTP listen address |
| `DB_PATH` | `./family-tab.db` | SQLite database |
| `BACKUP_DIR` | empty | Directory for periodic `VACUUM INTO` copies; disabled when empty |
| `BACKUP_INTERVAL` | `6h` | Time between database copies |
| `BACKUP_KEEP` | `28` | Number of database copies to keep |
| `LOG_LEVEL` | `INFO` | Log level |
| `COOKIE_INSECURE` | `false` | Drop the `Secure` cookie attribute, for local HTTP development only |

The OIDC client must allow PKCE `S256` and the `query` response mode.

## Development

```sh
make web    # build the frontend
make dev    # run the server
make test
```
