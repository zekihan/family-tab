package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/zekihan/family-tab/internal/protocol"
)

type identityKey struct{}

func (svc *Service) isBuyer(issuer, subject string) bool {
	return issuer == svc.cfg.Issuer && subject != "" && subject == svc.cfg.BuyerSubject
}

func (svc *Service) createSession(
	ctx context.Context,
	w http.ResponseWriter,
	me *protocol.Me,
) bool {
	value := randomToken()
	now := svc.now()
	created := timestamp(now)

	_, err := svc.db.ExecContext(ctx, `
		INSERT INTO sessions (token_hash, issuer, subject, name, email, created_at, renewed_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		tokenHash(value), svc.cfg.Issuer, me.Subject, me.Name, me.Email,
		created, created, timestamp(now.Add(sessionLifetime)),
	)
	if err != nil {
		return false
	}

	svc.setCookie(w, sessionCookie, "/", value, int(sessionLifetime/time.Second))

	return true
}

// LogoutHandler serves POST /api/logout. It needs no valid session.
func (svc *Service) LogoutHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodPost) {
			return
		}

		cookie, err := r.Cookie(sessionCookie)
		if err == nil && cookie.Value != "" {
			_, err = svc.db.ExecContext(r.Context(), "DELETE FROM sessions WHERE token_hash = ?",
				tokenHash(cookie.Value))
			if err != nil {
				slog.ErrorContext(r.Context(), "Could not delete session on sign-out")
			}
		}

		svc.setCookie(w, sessionCookie, "/", "", -1)
		w.WriteHeader(http.StatusNoContent)
	})
}

// RequireSession rejects requests without a valid session with 401 JSON and
// renews the session when due. The identity is available via Identity.
func (svc *Service) RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")

		cookie, err := r.Cookie(sessionCookie)
		if err != nil || cookie.Value == "" {
			unauthenticated(w)

			return
		}

		ctx := r.Context()
		now := svc.now()
		hash := tokenHash(cookie.Value)

		var (
			me              protocol.Me
			issuer, renewed string
		)

		err = svc.db.QueryRowxContext(ctx, `
			SELECT issuer, subject, name, email, renewed_at FROM sessions
			WHERE token_hash = ? AND expires_at > ?`, hash, timestamp(now),
		).Scan(&issuer, &me.Subject, &me.Name, &me.Email, &renewed)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			sessionError(w)

			return
		}

		if err != nil || !svc.isBuyer(issuer, me.Subject) {
			unauthenticated(w)

			return
		}

		if renewed < timestamp(now.Add(-renewalInterval)) {
			didRenew, err := svc.renewSession(ctx, now, hash, renewed)
			if err != nil {
				sessionError(w)

				return
			}

			if didRenew {
				svc.setCookie(w, sessionCookie, "/", cookie.Value, int(sessionLifetime/time.Second))
			}
		}

		next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, identityKey{}, me)))
	})
}

func (svc *Service) renewSession(
	ctx context.Context,
	now time.Time,
	hash, renewed string,
) (bool, error) {
	// Match the observed renewal so concurrent requests extend the session only once.
	result, err := svc.db.ExecContext(ctx, `
		UPDATE sessions SET renewed_at = ?, expires_at = ?
		WHERE token_hash = ? AND renewed_at = ? AND expires_at > ?`,
		timestamp(now), timestamp(now.Add(sessionLifetime)), hash, renewed, timestamp(now),
	)
	if err != nil {
		return false, fmt.Errorf("renew session: %w", err)
	}

	count, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("count renewed sessions: %w", err)
	}

	return count == 1, nil
}

func unauthenticated(w http.ResponseWriter) {
	writeSessionError(w, http.StatusUnauthorized, "unauthenticated", "Sign in to continue.")
}

func sessionError(w http.ResponseWriter) {
	writeSessionError(w, http.StatusInternalServerError, "internal", "Could not check the session.")
}

func writeSessionError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	//nolint:errcheck,errchkjson // A write failure cannot change the response after headers are sent.
	_ = json.NewEncoder(w).Encode(protocol.ErrorResponse{Error: code, Message: message})
}

// Identity returns the signed-in buyer stored on the request context by
// RequireSession.
func Identity(ctx context.Context) (protocol.Me, bool) {
	me, ok := ctx.Value(identityKey{}).(protocol.Me)

	return me, ok
}
