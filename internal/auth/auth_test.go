package auth

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/oauth2-proxy/mockoidc"

	_ "modernc.org/sqlite"

	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

type authFixture struct {
	provider *mockoidc.MockOIDC
	service  *Service
	now      time.Time
}

func openTestDB(t *testing.T) *sqlx.DB {
	t.Helper()

	db, err := sqlx.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		closeErr := db.Close()
		if closeErr != nil {
			t.Error(closeErr)
		}
	})
	db.SetMaxOpenConns(1)

	for _, migration := range store.Migrations {
		_, migrationErr := db.ExecContext(t.Context(), migration)
		if migrationErr != nil {
			t.Fatal(migrationErr)
		}
	}

	return db
}

func newFixture(t *testing.T, insecure bool) *authFixture {
	t.Helper()

	db := openTestDB(t)

	provider, err := mockoidc.Run()
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		shutdownErr := provider.Shutdown()
		if shutdownErr != nil {
			t.Error(shutdownErr)
		}
	})

	service, err := New(t.Context(), &Config{
		PublicURL:      "https://tab.example",
		Issuer:         provider.Issuer(),
		ClientID:       provider.ClientID,
		ClientSecret:   provider.ClientSecret,
		BuyerSubject:   mockoidc.DefaultUser().Subject,
		MCPClientID:    "",
		MCPAudience:    "",
		CookieInsecure: insecure,
	}, db)
	if err != nil {
		t.Fatal(err)
	}

	fixture := &authFixture{provider: provider, service: service, now: time.Now()}
	service.now = func() time.Time { return fixture.now }

	return fixture
}

func call(
	t *testing.T,
	handler http.Handler,
	method, target string,
	cookie *http.Cookie,
) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequestWithContext(t.Context(), method, target, nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	return recorder
}

func expectStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()

	if response.Code != want {
		t.Fatalf("status = %d, want %d", response.Code, want)
	}
}

func expectCookie(
	t *testing.T,
	response *httptest.ResponseRecorder,
	name, path string,
	age int,
	secure bool,
) *http.Cookie {
	t.Helper()

	for _, header := range response.Header().Values("Set-Cookie") {
		cookie, err := http.ParseSetCookie(header)
		if err != nil {
			t.Fatal("invalid Set-Cookie header")
		}

		if cookie.Name != name {
			continue
		}

		if cookie.Path != path || cookie.MaxAge != age || !cookie.HttpOnly ||
			cookie.SameSite != http.SameSiteLaxMode || cookie.Secure != secure || cookie.Domain != "" {
			t.Fatal("unexpected cookie attributes")
		}

		if age < 0 {
			if cookie.Value != "" {
				t.Fatal("cleared cookie has a value")
			}
		} else {
			raw, decodeErr := base64.RawURLEncoding.DecodeString(cookie.Value)
			if decodeErr != nil || len(raw) < 32 {
				t.Fatal("cookie does not carry a token of at least 32 bytes")
			}
		}

		return cookie
	}

	t.Fatalf("response missing %s cookie", name)

	return nil
}

func (fixture *authFixture) login(t *testing.T) (*url.URL, *http.Cookie) {
	t.Helper()

	response := call(t, fixture.service.LoginHandler(), http.MethodGet, "/auth/login", nil)
	expectStatus(t, response, http.StatusSeeOther)
	cookie := expectCookie(
		t,
		response,
		oidcCookie,
		callbackPath,
		600,
		!fixture.service.cfg.CookieInsecure,
	)

	location, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}

	query := location.Query()
	if query.Get("code_challenge_method") != "S256" || query.Get("code_challenge") == "" ||
		query.Get(
			"nonce",
		) == "" || query.Get("state") == "" || query.Get("response_mode") != "query" ||
		query.Get("redirect_uri") != "https://tab.example/auth/callback" ||
		query.Get("scope") != "openid profile email" {
		t.Fatal("incomplete or invalid OIDC authorization parameters")
	}

	var hash string

	err = fixture.service.db.GetContext(t.Context(), &hash,
		"SELECT id_hash FROM oidc_transactions WHERE state = ?", query.Get("state"),
	)
	if err != nil || hash != tokenHash(cookie.Value) {
		t.Fatal("transaction is missing or stored with the wrong cookie hash")
	}

	return location, cookie
}

func authorizationCallback(t *testing.T, location *url.URL) string {
	t.Helper()

	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       5 * time.Second,
		Transport:     nil,
		Jar:           nil,
	}

	request, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		location.String(),
		http.NoBody,
	)
	if err != nil {
		t.Fatal(err)
	}

	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	callback, err := response.Location()
	if err != nil || callback.Query().Get("code") == "" {
		t.Fatalf("mock provider did not return a code (status %d)", response.StatusCode)
	}

	return callback.RequestURI()
}

func (fixture *authFixture) signIn(t *testing.T) *http.Cookie {
	t.Helper()

	location, transaction := fixture.login(t)
	callback := authorizationCallback(t, location)
	response := call(t, fixture.service.CallbackHandler(), http.MethodGet, callback, transaction)
	expectStatus(t, response, http.StatusSeeOther)

	if response.Header().Get("Location") != "/" {
		t.Fatal("callback did not redirect to the app")
	}

	secure := !fixture.service.cfg.CookieInsecure
	expectCookie(t, response, oidcCookie, callbackPath, -1, secure)

	return expectCookie(t, response, sessionCookie, "/", 2592000, secure)
}

func (fixture *authFixture) requestMe(
	t *testing.T,
	cookie *http.Cookie,
) *httptest.ResponseRecorder {
	t.Helper()

	handler := fixture.service.RequireSession(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			me, ok := Identity(r.Context())
			if !ok {
				t.Error("authenticated handler called without an identity")
			}

			err := json.NewEncoder(w).Encode(me)
			if err != nil {
				t.Error(err)
			}
		}),
	)

	return call(t, handler, http.MethodGet, "/api/me", cookie)
}

func expectUnauthorized(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	expectStatus(t, response, http.StatusUnauthorized)

	var body protocol.ErrorResponse

	err := json.NewDecoder(response.Body).Decode(&body)
	if err != nil {
		t.Fatal(err)
	}

	if body.Error != "unauthenticated" || body.Message == "" {
		t.Fatalf("unexpected unauthorized response: %+v", body)
	}
}

func TestSignInAndRenewal(t *testing.T) {
	t.Parallel()

	fixture := newFixture(t, false)
	cookie := fixture.signIn(t)
	started := fixture.now

	response := fixture.requestMe(t, cookie)
	expectStatus(t, response, http.StatusOK)

	var me protocol.Me

	err := json.NewDecoder(response.Body).Decode(&me)
	if err != nil {
		t.Fatal(err)
	}

	user := mockoidc.DefaultUser()
	if me.Subject != user.Subject || me.Name != nil || me.Email == nil || *me.Email != user.Email {
		t.Fatalf("unexpected identity: %+v", me)
	}

	fixture.now = started.Add(time.Hour)
	response = fixture.requestMe(t, cookie)
	expectStatus(t, response, http.StatusOK)

	if len(response.Header().Values("Set-Cookie")) != 0 {
		t.Fatal("session renewed before it was older than one hour")
	}

	fixture.now = fixture.now.Add(time.Second)
	response = fixture.requestMe(t, cookie)
	expectStatus(t, response, http.StatusOK)

	renewed := expectCookie(t, response, sessionCookie, "/", 2592000, true)
	if renewed.Value != cookie.Value {
		t.Fatal("renewal did not retain the session token")
	}

	var created, lastRenewed, expires string

	err = fixture.service.db.QueryRowxContext(t.Context(), `
		SELECT created_at, renewed_at, expires_at FROM sessions WHERE token_hash = ?`,
		tokenHash(cookie.Value),
	).Scan(&created, &lastRenewed, &expires)
	if err != nil {
		t.Fatal(err)
	}

	if created != timestamp(started) || lastRenewed != timestamp(fixture.now) ||
		expires != timestamp(fixture.now.Add(30*24*time.Hour)) {
		t.Fatal("renewal did not extend the stored expiry")
	}

	fixture.now = fixture.now.Add(time.Minute)
	response = fixture.requestMe(t, cookie)
	expectStatus(t, response, http.StatusOK)

	if len(response.Header().Values("Set-Cookie")) != 0 {
		t.Fatal("session renewed twice in an hour")
	}
}

func TestWrongSubject(t *testing.T) {
	t.Parallel()

	fixture := newFixture(t, false)
	user := mockoidc.DefaultUser()
	user.Subject = "different-account"
	fixture.provider.QueueUser(user)

	location, transaction := fixture.login(t)
	callback := authorizationCallback(t, location)
	response := call(t, fixture.service.CallbackHandler(), http.MethodGet, callback, transaction)
	expectStatus(t, response, http.StatusForbidden)
	expectCookie(t, response, oidcCookie, callbackPath, -1, true)

	var count int

	err := fixture.service.db.GetContext(t.Context(), &count, "SELECT count(*) FROM sessions")
	if err != nil {
		t.Fatal(err)
	}

	if count != 0 {
		t.Fatal("unauthorized account created a session")
	}
}

func TestCallbackRejection(t *testing.T) {
	t.Parallel()

	for _, test := range []string{
		"missing cookie", "unknown cookie", "state mismatch", "expired", "provider error", "nonce mismatch",
	} {
		t.Run(test, func(t *testing.T) {
			t.Parallel()

			fixture := newFixture(t, false)
			location, cookie := fixture.login(t)

			hash := tokenHash(cookie.Value)

			if test == "nonce mismatch" {
				query := location.Query()
				query.Set("nonce", "different-nonce")
				location.RawQuery = query.Encode()
			}

			callback := authorizationCallback(t, location)

			requestURL, err := url.Parse(callback)
			if err != nil {
				t.Fatal(err)
			}

			query := requestURL.Query()

			switch test {
			case "missing cookie":
				cookie = nil
			case "unknown cookie":
				cookie.Value = randomToken()
			case "state mismatch":
				query.Set("state", "different-state")
			case "expired":
				fixture.now = fixture.now.Add(10 * time.Minute)
			case "provider error":
				query.Set("error", "access_denied")
			}

			requestURL.RawQuery = query.Encode()
			response := call(
				t,
				fixture.service.CallbackHandler(),
				http.MethodGet,
				requestURL.RequestURI(),
				cookie,
			)
			expectStatus(t, response, http.StatusBadRequest)
			expectCookie(t, response, oidcCookie, callbackPath, -1, true)

			if !strings.Contains(response.Body.String(), `href="/auth/login"`) {
				t.Fatal("invalid callback page lacks a login link")
			}

			var count int

			err = fixture.service.db.GetContext(t.Context(), &count,
				"SELECT count(*) FROM oidc_transactions WHERE id_hash = ?", hash)
			if err != nil {
				t.Fatal(err)
			}

			want := 0
			if test == "missing cookie" || test == "unknown cookie" {
				want = 1
			}

			if count != want {
				t.Fatalf("remaining sign-in transactions = %d, want %d", count, want)
			}
		})
	}
}

func TestCallbackReplay(t *testing.T) {
	t.Parallel()

	fixture := newFixture(t, false)
	location, cookie := fixture.login(t)
	target := authorizationCallback(t, location)

	handler := fixture.service.CallbackHandler()
	expectStatus(t, call(t, handler, http.MethodGet, target, cookie), http.StatusSeeOther)
	expectStatus(t, call(t, handler, http.MethodGet, target, cookie), http.StatusBadRequest)

	var remaining int

	err := fixture.service.db.GetContext(t.Context(), &remaining,
		"SELECT count(*) FROM oidc_transactions WHERE id_hash = ?", tokenHash(cookie.Value))
	if err != nil {
		t.Fatal(err)
	}

	if remaining != 0 {
		t.Fatal("callback did not consume the sign-in transaction")
	}
}

func TestInvalidSessionsAndLogout(t *testing.T) {
	t.Parallel()

	fixture := newFixture(t, true)

	cookies, err := http.ParseCookie(sessionCookie + "=" + randomToken())
	if err != nil {
		t.Fatal(err)
	}

	unknown := cookies[0]

	expectUnauthorized(t, fixture.requestMe(t, nil))
	expectUnauthorized(t, fixture.requestMe(t, unknown))

	valid := fixture.signIn(t)
	for _, cookie := range []*http.Cookie{nil, unknown, valid, valid} {
		response := call(t, fixture.service.LogoutHandler(), http.MethodPost, "/api/logout", cookie)
		expectStatus(t, response, http.StatusNoContent)
		expectCookie(t, response, sessionCookie, "/", -1, false)
	}

	expectUnauthorized(t, fixture.requestMe(t, valid))

	expiring := fixture.signIn(t)
	fixture.now = fixture.now.Add(30 * 24 * time.Hour)
	expectUnauthorized(t, fixture.requestMe(t, expiring))

	fixture.login(t)

	var count int

	err = fixture.service.db.GetContext(t.Context(), &count, "SELECT count(*) FROM sessions")
	if err != nil {
		t.Fatal(err)
	}

	if count != 0 {
		t.Fatal("expired and logged-out sessions should be gone")
	}
}

func TestCallbackOnlyAcceptsGet(t *testing.T) {
	t.Parallel()

	fixture := newFixture(t, false)
	response := call(t, fixture.service.CallbackHandler(), http.MethodPost, callbackPath, nil)
	expectStatus(t, response, http.StatusMethodNotAllowed)
	expectCookie(t, response, oidcCookie, callbackPath, -1, true)
}
