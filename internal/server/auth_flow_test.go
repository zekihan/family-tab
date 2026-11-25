package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oauth2-proxy/mockoidc"
	"github.com/zekihan/go-commons/mockidp"
	"github.com/zekihan/go-commons/oidcauth"

	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
)

// TestSignInRejectsNonBuyer covers the buyer-only sign-in rule through the
// shared oidcauth and mockidp packages: a verified identity whose subject is
// not the configured buyer gets 403 and no session. The Playwright suite
// cannot queue a second user through the shared mock IdP command.
func TestSignInRejectsNonBuyer(t *testing.T) {
	t.Parallel()

	idp, err := mockidp.Start(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = idp.Close() })

	st, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = st.Close() })

	authSvc := newTestAuthService(t, idp, st)
	callbackRec := completeSignInAsOther(t, authSvc, idp)

	if callbackRec.Code != http.StatusForbidden ||
		!strings.Contains(callbackRec.Body.String(), "This account cannot access Family Tab.") {
		t.Fatalf(
			"callback = %d %s, want 403 buyer rejection",
			callbackRec.Code,
			callbackRec.Body.String(),
		)
	}

	for _, cookie := range callbackRec.Result().Cookies() {
		if cookie.Name == "ft_session" && cookie.Value != "" {
			t.Fatal("rejected sign-in set a session cookie")
		}
	}

	var sessions int

	err = st.DB().GetContext(t.Context(), &sessions, "SELECT count(*) FROM sessions")
	if err != nil {
		t.Fatal(err)
	}

	if sessions != 0 {
		t.Fatalf("rejected sign-in created %d sessions", sessions)
	}
}

func newTestAuthService(
	t *testing.T,
	idp *mockidp.Server,
	st *store.Store,
) *oidcauth.Service[protocol.Me] {
	t.Helper()

	authSvc, err := oidcauth.New(t.Context(), &oidcauth.Config[protocol.Me]{
		Authorize: func(info oidcauth.IdentityInfo) (protocol.Me, bool) {
			return protocol.Me{Subject: info.Subject, Name: info.Name, Email: info.Email},
				info.Subject != ""
		},
		HTTPClient: nil, PublicURL: "https://tab.example", Issuer: idp.Config.Issuer,
		ClientID: idp.Config.ClientID, ClientSecret: idp.Config.ClientSecret,
		OwnerSubject: idp.Config.Subject, MCPClientID: "", MCPAudience: "",
		AppName: "Family Tab", SessionCookie: "ft_session", TransactionCookie: "ft_oidc_tx",
		SuccessPath: "/", CookieInsecure: false,
	}, st.DB())
	if err != nil {
		t.Fatal(err)
	}

	return authSvc
}

func completeSignInAsOther(
	t *testing.T,
	authSvc *oidcauth.Service[protocol.Me],
	idp *mockidp.Server,
) *httptest.ResponseRecorder {
	t.Helper()

	loginRec := httptest.NewRecorder()
	authSvc.LoginHandler().ServeHTTP(loginRec,
		httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/auth/login", nil))

	if loginRec.Code != http.StatusSeeOther {
		t.Fatalf("login status = %d, body %s", loginRec.Code, loginRec.Body.String())
	}

	var txCookie *http.Cookie

	for _, cookie := range loginRec.Result().Cookies() {
		if cookie.Name == "ft_oidc_tx" {
			txCookie = cookie
		}
	}

	if txCookie == nil {
		t.Fatal("login did not set the transaction cookie")
	}

	other := mockoidc.DefaultUser()
	other.Subject = "someone-else"
	idp.Provider().QueueUser(other)

	client := &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: nil, Jar: nil, Timeout: 5 * time.Second,
	}

	authReq, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
		loginRec.Header().Get("Location"), http.NoBody)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := client.Do(authReq)
	if err != nil {
		t.Fatal(err)
	}

	_ = resp.Body.Close()

	callbackURL, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}

	if callbackURL.Query().Get("code") == "" {
		t.Fatalf("authorize redirect has no code: %s", callbackURL)
	}

	callbackReq := httptest.NewRequestWithContext(t.Context(), http.MethodGet,
		"/auth/callback?"+callbackURL.RawQuery, nil)
	callbackReq.AddCookie(txCookie)

	callbackRec := httptest.NewRecorder()
	authSvc.CallbackHandler().ServeHTTP(callbackRec, callbackReq)

	return callbackRec
}
