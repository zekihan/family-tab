package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zekihan/family-tab/internal/protocol"
)

const (
	testMCPClient   = "claude"
	testMCPAudience = "https://tab.example/mcp"
	testBuyer       = "buyer-subject"
	testKeyID       = "k1"
	testMetadataURL = "https://tab.example/.well-known/oauth-protected-resource"
)

var (
	testKeysOnce          sync.Once
	testSigningKey, rogue *rsa.PrivateKey
	errTestKeyGeneration  error
)

func testKeys(t *testing.T) (*rsa.PrivateKey, *rsa.PrivateKey) {
	t.Helper()

	testKeysOnce.Do(func() {
		testSigningKey, errTestKeyGeneration = rsa.GenerateKey(rand.Reader, 2048)
		if errTestKeyGeneration == nil {
			rogue, errTestKeyGeneration = rsa.GenerateKey(rand.Reader, 2048)
		}
	})

	if errTestKeyGeneration != nil {
		t.Fatal(errTestKeyGeneration)
	}

	return testSigningKey, rogue
}

type bearerFixture struct {
	now     time.Time
	service *Service
	key     *rsa.PrivateKey
	rogue   *rsa.PrivateKey
	issuer  string
}

// newBearerFixture serves a discovery document and JWKS for a local RSA key.
func newBearerFixture(t *testing.T, mcpClient string) *bearerFixture {
	t.Helper()

	key, rogueKey := testKeys(t)
	mux := http.NewServeMux()
	issuer := httptest.NewServer(mux)
	t.Cleanup(issuer.Close)

	writeJSON := func(w http.ResponseWriter, value any) {
		w.Header().Set("Content-Type", "application/json")

		err := json.NewEncoder(w).Encode(value)
		if err != nil {
			t.Error(err)
		}
	}

	mux.HandleFunc(
		"/.well-known/openid-configuration",
		func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, map[string]any{
				"issuer":                                issuer.URL,
				"authorization_endpoint":                issuer.URL + "/authorize",
				"token_endpoint":                        issuer.URL + "/token",
				"jwks_uri":                              issuer.URL + "/jwks",
				"id_token_signing_alg_values_supported": []string{"RS256"},
			})
		},
	)
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"keys": []map[string]string{{
			"kty": "RSA",
			"kid": testKeyID,
			"use": "sig",
			"alg": "RS256",
			"n":   base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})

	service, err := New(t.Context(), &Config{
		PublicURL:      "https://tab.example/",
		Issuer:         issuer.URL,
		ClientID:       "family-tab",
		ClientSecret:   "secret",
		BuyerSubject:   testBuyer,
		MCPClientID:    mcpClient,
		MCPAudience:    testMCPAudience,
		CookieInsecure: false,
	}, openTestDB(t))
	if err != nil {
		t.Fatal(err)
	}

	fixture := &bearerFixture{
		service: service,
		key:     key,
		rogue:   rogueKey,
		issuer:  issuer.URL,
		now:     time.Now().Truncate(time.Second),
	}
	service.now = func() time.Time { return fixture.now }

	return fixture
}

func (fixture *bearerFixture) claims() jwt.MapClaims {
	return jwt.MapClaims{
		"iss":       fixture.issuer,
		"sub":       testBuyer,
		"aud":       []string{testMCPAudience},
		"exp":       fixture.now.Add(5 * time.Minute).Unix(),
		"iat":       fixture.now.Unix(),
		"nbf":       fixture.now.Unix(),
		"jti":       "token-id",
		"client_id": testMCPClient,
		"scope":     "openid offline_access",
		"name":      "Buyer",
		"email":     "buyer@example.com",
	}
}

func (fixture *bearerFixture) sign(
	t *testing.T,
	method jwt.SigningMethod,
	key any,
	header map[string]any,
	claims jwt.MapClaims,
) string {
	t.Helper()

	token := jwt.NewWithClaims(method, claims)
	token.Header["kid"] = testKeyID
	token.Header["typ"] = "at+jwt"

	for name, value := range header {
		if value == nil {
			delete(token.Header, name)
		} else {
			token.Header[name] = value
		}
	}

	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}

	return signed
}

func (fixture *bearerFixture) token(
	t *testing.T,
	header map[string]any,
	change func(jwt.MapClaims),
) string {
	t.Helper()

	claims := fixture.claims()
	if change != nil {
		change(claims)
	}

	return fixture.sign(t, jwt.SigningMethodRS256, fixture.key, header, claims)
}

func (fixture *bearerFixture) request(
	t *testing.T,
	target string,
	authorization ...string,
) *httptest.ResponseRecorder {
	t.Helper()

	handler := fixture.service.RequireBearer(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			me, ok := Identity(r.Context())
			if !ok {
				t.Error("bearer handler called without an identity")
			}

			err := json.NewEncoder(w).Encode(me)
			if err != nil {
				t.Error(err)
			}
		}),
	)

	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, target, nil)
	for _, value := range authorization {
		request.Header.Add("Authorization", value)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	return recorder
}

func expectChallenge(t *testing.T, response *httptest.ResponseRecorder, code string) {
	t.Helper()
	expectUnauthorized(t, response)

	want := `Bearer resource_metadata="` + testMetadataURL + `"`
	if code != "" {
		want += `, error="` + code + `"`
	}

	if got := response.Header().Get("WWW-Authenticate"); got != want {
		t.Fatalf("WWW-Authenticate = %q, want %q", got, want)
	}
}

func expectIdentity(t *testing.T, response *httptest.ResponseRecorder, name, email *string) {
	t.Helper()
	expectStatus(t, response, http.StatusOK)

	var me protocol.Me

	err := json.NewDecoder(response.Body).Decode(&me)
	if err != nil {
		t.Fatal(err)
	}

	if me.Subject != testBuyer || !equalOptional(me.Name, name) || !equalOptional(me.Email, email) {
		t.Fatalf("unexpected identity: %+v", me)
	}
}

func equalOptional(got, want *string) bool {
	if got == nil || want == nil {
		return got == want
	}

	return *got == *want
}

func TestBearerAccepted(t *testing.T) {
	t.Parallel()

	fixture := newBearerFixture(t, testMCPClient)
	name, email := new("Buyer"), new("buyer@example.com")

	noChange := func(jwt.MapClaims) {}
	cases := []struct {
		header map[string]any
		change func(jwt.MapClaims)
		wantN  *string
		wantE  *string
		name   string
		scheme string
	}{
		{nil, noChange, name, email, "at+jwt", "Bearer "},
		{nil, noChange, name, email, "lowercase scheme", "bearer "},
		{
			map[string]any{"typ": "application/at+jwt"},
			noChange, name, email, "application/at+jwt", "Bearer ",
		},
		{map[string]any{"typ": nil}, noChange, name, email, "no typ", "Bearer "},
		{
			nil,
			func(claims jwt.MapClaims) {
				delete(claims, "client_id")
				claims["azp"] = testMCPClient
			},
			name, email, "azp without client_id", "Bearer ",
		},
		{
			nil,
			func(claims jwt.MapClaims) {
				claims["aud"] = testMCPAudience
				delete(claims, "name")
				delete(claims, "email")
			},
			nil, nil, "string audience, no profile claims", "Bearer ",
		},
		{
			nil,
			func(claims jwt.MapClaims) {
				claims["aud"] = []string{"other", testMCPAudience}
			},
			name, email, "multiple audiences", "Bearer ",
		},
		{
			nil,
			func(claims jwt.MapClaims) {
				claims["iat"] = fixture.now.Add(time.Minute).Unix()
				claims["nbf"] = fixture.now.Add(time.Minute).Unix()
			},
			name, email, "iat and nbf within skew", "Bearer ",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			response := fixture.request(t, "/mcp", tc.scheme+fixture.token(t, tc.header, tc.change))
			expectIdentity(t, response, tc.wantN, tc.wantE)

			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("bearer responses must not be cached")
			}
		})
	}
}

func TestBearerRejectsClaims(t *testing.T) {
	t.Parallel()

	fixture := newBearerFixture(t, testMCPClient)
	future := fixture.now.Add(10 * time.Minute).Unix()

	cases := map[string]func(jwt.MapClaims){
		"wrong issuer":         func(c jwt.MapClaims) { c["iss"] = fixture.issuer + "/other" },
		"missing audience":     func(c jwt.MapClaims) { delete(c, "aud") },
		"wrong audience":       func(c jwt.MapClaims) { c["aud"] = []string{"https://tab.example"} },
		"client as audience":   func(c jwt.MapClaims) { c["aud"] = testMCPClient },
		"missing exp":          func(c jwt.MapClaims) { delete(c, "exp") },
		"expired":              func(c jwt.MapClaims) { c["exp"] = fixture.now.Add(-time.Second).Unix() },
		"nbf in future":        func(c jwt.MapClaims) { c["nbf"] = future },
		"iat in future":        func(c jwt.MapClaims) { c["iat"] = future },
		"missing iat":          func(c jwt.MapClaims) { delete(c, "iat") },
		"wrong client_id":      func(c jwt.MapClaims) { c["client_id"] = "other" },
		"null client_id":       func(c jwt.MapClaims) { c["client_id"] = nil },
		"numeric client_id":    func(c jwt.MapClaims) { c["client_id"] = 1 },
		"no client_id or azp":  func(c jwt.MapClaims) { delete(c, "client_id") },
		"wrong azp":            func(c jwt.MapClaims) { delete(c, "client_id"); c["azp"] = "other" },
		"client_id beats azp":  func(c jwt.MapClaims) { c["client_id"] = "other"; c["azp"] = testMCPClient },
		"wrong subject":        func(c jwt.MapClaims) { c["sub"] = "someone-else" },
		"missing subject":      func(c jwt.MapClaims) { delete(c, "sub") },
		"nonce (an ID token)":  func(c jwt.MapClaims) { c["nonce"] = "n" },
		"empty nonce":          func(c jwt.MapClaims) { c["nonce"] = "" },
		"ID token for the app": func(c jwt.MapClaims) { c["aud"] = "family-tab"; delete(c, "client_id") },
	}

	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			response := fixture.request(t, "/mcp", "Bearer "+fixture.token(t, nil, change))
			expectChallenge(t, response, "invalid_token")
		})
	}
}

func TestBearerRejectsHeadersAndSignatures(t *testing.T) {
	t.Parallel()

	fixture := newBearerFixture(t, testMCPClient)
	claims := fixture.claims()

	valid := fixture.token(t, nil, nil)
	parts := strings.Split(valid, ".")
	otherPayload := strings.Split(fixture.token(t, nil, func(c jwt.MapClaims) {
		c["sub"] = "other"
	}), ".")[1]

	cases := map[string]string{
		"typ JWT": fixture.token(t, map[string]any{"typ": "JWT"}, nil),
		"typ id token": fixture.token(
			t,
			map[string]any{"typ": "application/jwt"},
			nil,
		),
		"none": fixture.sign(
			t,
			jwt.SigningMethodNone,
			jwt.UnsafeAllowNoneSignatureType,
			nil,
			claims,
		),
		"HS256": fixture.sign(t, jwt.SigningMethodHS256, []byte("secret"), nil, claims),
		"HS256 with public key bytes": fixture.sign(
			t,
			jwt.SigningMethodHS256,
			fixture.key.N.Bytes(),
			nil,
			claims,
		),
		"RS384":     fixture.sign(t, jwt.SigningMethodRS384, fixture.key, nil, claims),
		"PS256":     fixture.sign(t, jwt.SigningMethodPS256, fixture.key, nil, claims),
		"wrong key": fixture.sign(t, jwt.SigningMethodRS256, fixture.rogue, nil, claims),
		"unknown kid": fixture.sign(
			t,
			jwt.SigningMethodRS256,
			fixture.rogue,
			map[string]any{"kid": "k2"},
			claims,
		),
		"tampered":       parts[0] + "." + otherPayload + "." + parts[2],
		"no signature":   parts[0] + "." + parts[1] + ".",
		"bad header b64": "e30x." + parts[1] + "." + parts[2],
	}

	for name, token := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			expectChallenge(t, fixture.request(t, "/mcp", "Bearer "+token), "invalid_token")
		})
	}

	malformed := map[string][]string{
		"basic scheme":     {"Basic dXNlcjpwYXNz"},
		"scheme only":      {"Bearer"},
		"scheme and space": {"Bearer "},
		"two parts":        {"Bearer " + parts[0] + "." + parts[1]},
		"extra space":      {"Bearer  " + valid},
		"trailing data":    {"Bearer " + valid + " x"},
		"two headers":      {"Bearer " + valid, "Bearer " + valid},
	}

	for name, values := range malformed {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			expectChallenge(t, fixture.request(t, "/mcp", values...), "invalid_request")
		})
	}

	t.Run("missing", func(t *testing.T) {
		t.Parallel()

		expectChallenge(t, fixture.request(t, "/mcp"), "")
	})

	t.Run("query token", func(t *testing.T) {
		t.Parallel()

		expectChallenge(t, fixture.request(t, "/mcp?access_token="+valid), "invalid_request")
		expectChallenge(
			t,
			fixture.request(t, "/mcp?access_token="+valid, "Bearer "+valid),
			"invalid_request",
		)
	})

	t.Run("session cookie", func(t *testing.T) {
		t.Parallel()

		handler := fixture.service.RequireBearer(
			http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Error("cookie accepted on the bearer endpoint")
			}),
		)
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/mcp", nil)
		request.Header.Set("Cookie", sessionCookie+"="+valid)

		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		expectChallenge(t, recorder, "")
	})
}

func TestProtectedResourceMetadata(t *testing.T) {
	t.Parallel()

	fixture := newBearerFixture(t, testMCPClient)
	if !fixture.service.MCPEnabled() {
		t.Fatal("MCP should be enabled")
	}

	response := call(
		t,
		fixture.service.ProtectedResourceHandler(),
		http.MethodGet,
		"/.well-known/oauth-protected-resource",
		nil,
	)
	expectStatus(t, response, http.StatusOK)

	if response.Header().Get("Content-Type") != "application/json" {
		t.Fatal("metadata is not JSON")
	}

	var body map[string]any

	err := json.NewDecoder(response.Body).Decode(&body)
	if err != nil {
		t.Fatal(err)
	}

	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}

	want := `{"authorization_servers":["` + fixture.issuer + `"],` +
		`"bearer_methods_supported":["header"],"resource":"` + testMCPAudience + `",` +
		`"scopes_supported":["openid","offline_access"]}`
	if string(encoded) != want {
		t.Fatalf("metadata = %s, want %s", encoded, want)
	}

	response = call(
		t,
		fixture.service.ProtectedResourceHandler(),
		http.MethodPost,
		"/.well-known/oauth-protected-resource",
		nil,
	)
	expectStatus(t, response, http.StatusMethodNotAllowed)
}

func TestMCPDisabled(t *testing.T) {
	t.Parallel()

	fixture := newBearerFixture(t, "")
	if fixture.service.MCPEnabled() {
		t.Fatal("MCP should be disabled")
	}

	expectStatus(
		t,
		fixture.request(t, "/mcp", "Bearer "+fixture.token(t, nil, nil)),
		http.StatusNotFound,
	)
	expectStatus(
		t,
		call(t, fixture.service.ProtectedResourceHandler(), http.MethodGet, "/", nil),
		http.StatusNotFound,
	)
}
