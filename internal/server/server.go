// Package server wires the HTTP routes: the JSON API, the auth endpoints and
// the embedded single-page app.
package server

import (
	"io/fs"
	"net/http"

	"github.com/zekihan/family-tab/internal/auth"
	"github.com/zekihan/family-tab/internal/syncsvc"
)

// Deps are the collaborators the server routes to.
type Deps struct {
	Auth *auth.Service
	Sync *syncsvc.Service
	// Web is the built frontend rooted at its index.html.
	Web fs.FS
}

type Server struct {
	deps Deps
}

func New(deps Deps) *Server { return &Server{deps: deps} }

// Handler returns the root handler.
func (s *Server) Handler() http.Handler { return http.NewServeMux() }
