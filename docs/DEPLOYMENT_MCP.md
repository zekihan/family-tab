# Family Tab: Agent Access Deployment

Status — homelab configuration for the MCP endpoint

This document lists what the homelab must configure so the buyer's Claude can reach `/mcp`. The homelab is a separate repository; nothing here is applied by this repo. The behavior is in [DESIGN.md](DESIGN.md) section 7 and the wire details in [PROTOCOL.md](PROTOCOL.md) sections 5 and 9.

## 1. Authelia client

Add a second OIDC client next to the PWA's. It is confidential, because Claude's custom connector sends a client secret, and it is limited to the buyer by its authorization policy.

```yaml
- client_id: family-tab-mcp
  client_name: Family Tab (Claude)
  client_secret: {path: /secrets/authelia-secret/OIDC_CLIENT_FAMILY_TAB_MCP_HASH}
  public: false
  authorization_policy: admin
  require_pkce: true
  pkce_challenge_method: S256
  redirect_uris: [https://claude.ai/api/mcp/auth_callback]
  scopes: [openid, offline_access]
  audience: [https://family-tab.noqer.com/mcp]
  requested_audience_mode: implicit
  grant_types: [authorization_code, refresh_token]
  response_types: [code]
  response_modes: [query]
  access_token_signed_response_alg: RS256
  token_endpoint_auth_method: client_secret_post
```

- `audience` must equal the app's `MCP_AUDIENCE`, which defaults to the public URL plus `/mcp`. `requested_audience_mode: implicit` puts it in the access token without the client sending a `resource` parameter.
- `access_token_signed_response_alg: RS256` makes the access token a JWT, which the server verifies against the issuer's keys. Authelia also needs an RS256 key in its `jwks`.
- Add a custom lifespan for this client under `identity_providers.oidc.lifespans.custom` and reference it from the client with `lifespan`:
  - `access_token`: 1 hour
  - `refresh_token`: 30 days

## 2. Secret

Add `OIDC_CLIENT_FAMILY_TAB_MCP_HASH` to the SOPS-encrypted secret and to the Authelia `externalSecret` keys. The value is the hashed client secret. The plain secret goes into Claude (section 4) and nowhere else.

## 3. Family Tab app

Set `MCP_CLIENT_ID=family-tab-mcp` in the app's environment. Leave `MCP_AUDIENCE` unset unless the public URL differs from the audience above. With `MCP_CLIENT_ID` empty, `/mcp` is disabled.

Add a test mirroring `apps/authelia/tests/test_native_family_tab.py` for the new client: its configuration, redirect URI, audience, signing algorithm, PKCE and lifespans.

## 4. Claude connector

In Claude, add a custom connector:

- URL: `https://family-tab.noqer.com/mcp`
- Under advanced settings, enter the client ID `family-tab-mcp` and the client secret. Authelia has no dynamic client registration, so Claude cannot register itself.

Signing in then goes through Authelia as the buyer. Another identity is refused by the server even with a valid token.

## 5. Check when setting up

- Confirm Claude's exact callback URL; if it differs from `https://claude.ai/api/mcp/auth_callback`, update `redirect_uris`.
- Confirm Claude's token endpoint authentication method. If the token exchange fails with `client_secret_post`, switch `token_endpoint_auth_method` to `client_secret_basic`.
- Check that no Cloudflare WAF or bot rule blocks Claude's servers from reaching `/mcp` and `/.well-known/oauth-protected-resource`.
- Verify that the app answers `/mcp` without a token with `401` and a `WWW-Authenticate` header naming the resource metadata, and that the metadata lists Authelia as the authorization server.
