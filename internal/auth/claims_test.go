package auth

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/oauth2-proxy/mockoidc"
)

type testIdentity struct {
	*mockoidc.IDTokenClaims

	AZP json.RawMessage `json:"azp,omitempty"`
}

type claimUser struct {
	*mockoidc.MockUser

	change func(*testIdentity)
}

//nolint:ireturn // Implements the mockoidc.User interface for signed test claims.
func (user *claimUser) Claims(_ []string, base *mockoidc.IDTokenClaims) (jwt.Claims, error) {
	claims := &testIdentity{IDTokenClaims: base, AZP: nil}
	user.change(claims)

	return claims, nil
}

func TestSignedTokenClaims(t *testing.T) {
	t.Parallel()

	tests := []struct {
		change func(*testIdentity)
		name   string
		status int
	}{
		{
			name: "missing iat",
			change: func(claims *testIdentity) {
				claims.IssuedAt = nil
			},
			status: http.StatusBadRequest,
		},
		{
			name: "future iat",
			change: func(claims *testIdentity) {
				claims.IssuedAt = jwt.NewNumericDate(claims.IssuedAt.Add(6 * time.Minute))
			},
			status: http.StatusBadRequest,
		},
		{
			name: "wrong azp",
			change: func(claims *testIdentity) {
				claims.AZP = json.RawMessage(`"different-client"`)
			},
			status: http.StatusBadRequest,
		},
		{
			name: "null azp",
			change: func(claims *testIdentity) {
				claims.AZP = json.RawMessage(`null`)
			},
			status: http.StatusBadRequest,
		},
		{
			name: "multiple audiences without azp",
			change: func(claims *testIdentity) {
				claims.Audience = append(claims.Audience, "other-client")
			},
			status: http.StatusBadRequest,
		},
		{
			name: "multiple audiences with correct azp",
			change: func(claims *testIdentity) {
				claims.AZP = json.RawMessage(strconv.Quote(claims.Audience[0]))
				claims.Audience = append(claims.Audience, "other-client")
			},
			status: http.StatusSeeOther,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			fixture := newFixture(t, false)
			fixture.provider.QueueUser(&claimUser{
				MockUser: mockoidc.DefaultUser(),
				change:   test.change,
			})

			location, transaction := fixture.login(t)
			target := authorizationCallback(t, location)
			response := call(
				t,
				fixture.service.CallbackHandler(),
				http.MethodGet,
				target,
				transaction,
			)
			expectStatus(t, response, test.status)
		})
	}
}
