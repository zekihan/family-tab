// Package server wires the HTTP routes: the JSON API, the auth endpoints and
// the embedded single-page app.
package server

import (
	"io/fs"
	"net/http"
	"strings"
	"sync"

	"github.com/zekihan/go-commons/metrics"
	"github.com/zekihan/go-commons/web/health"

	"github.com/zekihan/family-tab/internal/syncsvc"
)

const contentSecurityPolicy = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
	"frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

type Auth interface {
	LoginHandler() http.Handler
	CallbackHandler() http.Handler
	LogoutHandler() http.Handler
	RequireSession(next http.Handler) http.Handler
	// MCPEnabled reports whether /mcp and its metadata are served.
	MCPEnabled() bool
	RequireBearer(next http.Handler) http.Handler
	ProtectedResourceHandler() http.Handler
}

// Deps are the collaborators the server routes to.
type Deps struct {
	Auth Auth
	Sync *syncsvc.Service
	// MCP serves the agent endpoint at /mcp when Auth.MCPEnabled is true.
	MCP http.Handler
	// Web is the built frontend rooted at its index.html.
	Web fs.FS
}

type Server struct {
	deps       Deps
	metricsReg *metrics.Registry
	metricsMu  sync.Mutex
}

func New(deps Deps) *Server {
	return &Server{deps: deps, metricsReg: nil, metricsMu: sync.Mutex{}}
}

// Handler returns the root handler.
func (srv *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", health.GetHealth)
	mux.Handle("GET /auth/login", srv.deps.Auth.LoginHandler())
	mux.Handle("GET /auth/callback", srv.deps.Auth.CallbackHandler())
	mux.HandleFunc("GET /", srv.serveWeb)

	// /mcp takes every method and carries no X-Family-Tab header or cookie, so
	// it is routed before the mux, like /api. Disabled, it is a plain 404.
	mcpHandler := http.NotFoundHandler()

	if srv.deps.Auth.MCPEnabled() && srv.deps.MCP != nil {
		metadata := srv.deps.Auth.ProtectedResourceHandler()
		mcpHandler = srv.deps.Auth.RequireBearer(srv.deps.MCP)

		mux.Handle("GET /.well-known/oauth-protected-resource", metadata)
		mux.Handle("GET /.well-known/oauth-protected-resource/mcp", metadata)
	}

	api := srv.apiHandler()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")

		// Use the original path so ServeMux cannot redirect an API request
		// before the required header is checked.
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)

			return
		}

		if r.URL.Path == "/mcp" {
			mcpHandler.ServeHTTP(w, metrics.WithRoute(r, "/mcp"))

			return
		}

		mux.ServeHTTP(w, r)
	})
}
