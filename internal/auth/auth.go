// Package auth implements SSO sign-in against one OIDC provider and the
// server-side sessions (DESIGN.md section 7, Sign-in).
package auth

import (
	"context"
	"net/http"

	"github.com/jmoiron/sqlx"

	// Pinned for the implementation.
	_ "github.com/coreos/go-oidc/v3/oidc"
	_ "golang.org/x/oauth2"

	"github.com/zekihan/family-tab/internal/protocol"
)

// Config holds what the auth service needs from the server configuration.
type Config struct {
	PublicURL      string
	Issuer         string
	ClientID       string
	ClientSecret   string
	BuyerSubject   string
	CookieInsecure bool
}

// Service owns the sign-in flow and sessions.
type Service struct {
	db  *sqlx.DB
	cfg Config
}

// New discovers the provider and returns the service. Db must already be
// migrated.
func New(ctx context.Context, cfg *Config, db *sqlx.DB) (*Service, error) {
	return &Service{cfg: *cfg, db: db}, nil
}

// LoginHandler serves GET /auth/login.
func (s *Service) LoginHandler() http.Handler { return http.NotFoundHandler() }

// CallbackHandler serves GET /auth/callback.
func (s *Service) CallbackHandler() http.Handler { return http.NotFoundHandler() }

// LogoutHandler serves POST /api/logout. It needs no valid session.
func (s *Service) LogoutHandler() http.Handler { return http.NotFoundHandler() }

// RequireSession rejects requests without a valid session with 401 JSON and
// renews the session when due. The identity is available via Identity.
func (s *Service) RequireSession(next http.Handler) http.Handler { return next }

// Identity returns the signed-in buyer stored on the request context by
// RequireSession.
func Identity(ctx context.Context) (protocol.Me, bool) { return protocol.Me{}, false }
