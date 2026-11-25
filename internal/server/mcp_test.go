package server

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/zekihan/go-commons/oidcauth"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/zekihan/family-tab/internal/mcp"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
	"github.com/zekihan/family-tab/internal/syncsvc"
)

const (
	mcpClientID = "claude"
	mcpAudience = "https://tab.example/mcp"
	mcpBuyer    = "buyer-subject"
	mcpKeyID    = "k1"
	mcpMetadata = "https://tab.example/.well-known/oauth-protected-resource"
)

func indexPage() fstest.MapFS {
	return fstest.MapFS{"index.html": webFile("<!doctype html><title>Family Tab</title>")}
}

func TestMCPDisabledIsNotFound(t *testing.T) {
	t.Parallel()

	handler := New(Deps{
		Auth: fakeAuth{authenticated: true},
		Sync: nil,
		MCP: http.HandlerFunc(
			func(http.ResponseWriter, *http.Request) { t.Error("MCP handler reached") },
		),
		Web: indexPage(),
	}).Handler()

	for _, target := range []struct{ method, path string }{
		{http.MethodPost, "/mcp"},
		{http.MethodGet, "/mcp"},
		{http.MethodGet, "/mcp/"},
		{http.MethodGet, "/.well-known/oauth-protected-resource"},
		{http.MethodGet, "/.well-known/oauth-protected-resource/mcp"},
	} {
		request := httptest.NewRequestWithContext(
			t.Context(),
			target.method,
			target.path,
			http.NoBody,
		)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusNotFound ||
			strings.Contains(response.Body.String(), "Family Tab") {
			t.Errorf("%s %s: %d %s", target.method, target.path, response.Code, response.Body)
		}

		checkSecurityHeaders(t, response.Header())
	}
}

type mcpStack struct {
	key     *rsa.PrivateKey
	handler http.Handler
	issuer  string
}

func newMCPStack(t *testing.T) *mcpStack {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	issuer := httptest.NewServer(mux)
	t.Cleanup(issuer.Close)

	writeJSON := func(w http.ResponseWriter, value any) {
		w.Header().Set("Content-Type", "application/json")

		encodeErr := json.NewEncoder(w).Encode(value)
		if encodeErr != nil {
			t.Error(encodeErr)
		}
	}

	mux.HandleFunc(
		"/.well-known/openid-configuration",
		func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, map[string]any{
				"issuer": issuer.URL, "authorization_endpoint": issuer.URL + "/authorize",
				"token_endpoint": issuer.URL + "/token", "jwks_uri": issuer.URL + "/jwks",
				"id_token_signing_alg_values_supported": []string{"RS256"},
			})
		},
	)
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": mcpKeyID, "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})

	st, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "mcp.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	authSvc, err := oidcauth.New(t.Context(), &oidcauth.Config[protocol.Me]{
		HTTPClient: nil, SuccessPath: "/",
		PublicURL: "https://tab.example/", Issuer: issuer.URL, ClientID: "family-tab",
		ClientSecret: "secret", OwnerSubject: mcpBuyer, MCPClientID: mcpClientID,
		MCPAudience: mcpAudience, AppName: "Family Tab", SessionCookie: "ft_session",
		TransactionCookie: "ft_oidc_tx", CookieInsecure: false,
		Authorize: func(info oidcauth.IdentityInfo) (protocol.Me, bool) {
			return protocol.Me{Subject: info.Subject, Name: info.Name, Email: info.Email},
				info.Subject != ""
		},
	}, st.DB())
	if err != nil {
		t.Fatal(err)
	}

	syncSvc := syncsvc.New(st, time.Now)

	return &mcpStack{
		key: key, issuer: issuer.URL,
		handler: New(Deps{
			Auth: authSvc,
			Sync: syncSvc,
			MCP:  mcp.NewHandler(mcp.Deps{Ledger: syncSvc, Now: time.Now, Version: "test"}),
			Web:  indexPage(),
		}).Handler(),
	}
}

func (stack *mcpStack) token(t *testing.T) string {
	t.Helper()

	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss": stack.issuer, "sub": mcpBuyer, "aud": []string{mcpAudience},
		"exp": now.Add(5 * time.Minute).Unix(), "iat": now.Unix(), "client_id": mcpClientID,
	})
	token.Header["kid"] = mcpKeyID
	token.Header["typ"] = "at+jwt"

	signed, err := token.SignedString(stack.key)
	if err != nil {
		t.Fatal(err)
	}

	return signed
}

func TestMCPRequiresBearerToken(t *testing.T) {
	t.Parallel()

	stack := newMCPStack(t)
	challenge := `Bearer resource_metadata="` + mcpMetadata + `"`

	cases := []struct {
		header    http.Header
		name      string
		challenge string
	}{
		{name: "no credentials", challenge: challenge, header: http.Header{}},
		{
			name: "session cookie only", challenge: challenge,
			header: http.Header{"Cookie": {"ft_session=abc"}},
		},
		{
			name: "app header only", challenge: challenge,
			header: http.Header{"X-Family-Tab": {"1"}, "Cookie": {"ft_session=abc"}},
		},
		{
			name: "bad token", challenge: challenge + `, error="invalid_token"`,
			header: http.Header{"Authorization": {"Bearer not.a.jwt"}},
		},
	}

	for _, test := range cases {
		request := httptest.NewRequestWithContext(
			t.Context(), http.MethodPost, "/mcp", strings.NewReader("{}"))
		request.Header = test.header.Clone()
		request.Header.Set("Content-Type", "application/json")

		response := httptest.NewRecorder()
		stack.handler.ServeHTTP(response, request)

		if response.Code != http.StatusUnauthorized ||
			response.Header().Get("WWW-Authenticate") != test.challenge {
			t.Errorf("%s: %d, WWW-Authenticate %q", test.name, response.Code,
				response.Header().Get("WWW-Authenticate"))
		}

		checkSecurityHeaders(t, response.Header())
	}

	for _, path := range []string{
		"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
	} {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, http.NoBody)
		response := httptest.NewRecorder()
		stack.handler.ServeHTTP(response, request)

		var metadata oidcauth.ProtectedResource

		err := json.Unmarshal(response.Body.Bytes(), &metadata)
		if response.Code != http.StatusOK || err != nil || metadata.Resource != mcpAudience ||
			len(
				metadata.AuthorizationServers,
			) != 1 || metadata.AuthorizationServers[0] != stack.issuer {
			t.Errorf("%s: %d %s", path, response.Code, response.Body)
		}
	}
}

type bearerTransport struct {
	handler http.Handler
	token   string
}

func (transport *bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header.Set("Authorization", "Bearer "+transport.token)

	recorder := httptest.NewRecorder()
	transport.handler.ServeHTTP(recorder, request)

	return recorder.Result(), nil
}

func TestMCPServesToolsWithBearerToken(t *testing.T) {
	t.Parallel()

	stack := newMCPStack(t)

	implementation := new(sdk.Implementation)
	implementation.Name = "test"
	implementation.Version = "1"

	httpClient := new(http.Client)
	httpClient.Transport = &bearerTransport{handler: stack.handler, token: stack.token(t)}

	transport := new(sdk.StreamableClientTransport)
	transport.Endpoint = "https://tab.example/mcp"
	transport.HTTPClient = httpClient
	transport.DisableStandaloneSSE = true

	session, err := sdk.NewClient(implementation, nil).Connect(t.Context(), transport, nil)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = session.Close() })

	tools, err := session.ListTools(t.Context(), nil)
	if err != nil || len(tools.Tools) != 14 {
		t.Fatalf("tools = %v, %v", tools, err)
	}

	params := new(sdk.CallToolParams)
	params.Name = "list_people"

	result, err := session.CallTool(t.Context(), params)
	if err != nil || !result.IsError {
		t.Fatalf("list_people before setup = %+v, %v", result, err)
	}

	message, ok := result.Content[0].(*sdk.TextContent)
	if !ok || !strings.Contains(message.Text, "not set up") {
		t.Fatalf("list_people content = %+v", result.Content)
	}
}
