package server

import (
	"bytes"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

const (
	indexFile = "index.html"
	noCache   = "no-cache"
)

func (srv *Server) serveWeb(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "auth" || strings.HasPrefix(name, "auth/") {
		http.NotFound(w, r)

		return
	}

	web := srv.deps.Web
	if web != nil && name != indexFile && fs.ValidPath(name) && serveStatic(w, r, web, name) {
		return
	}

	extension := path.Ext(strings.TrimRight(name, "/"))
	isAsset := name == "assets" || strings.HasPrefix(name, "assets/")

	if name != indexFile && (isAsset || extension != "") {
		http.NotFound(w, r)

		return
	}

	w.Header().Set("Cache-Control", noCache)

	if web != nil {
		index, err := fs.ReadFile(web, indexFile)
		if err == nil {
			http.ServeContent(w, r, indexFile, time.Time{}, bytes.NewReader(index))

			return
		}
	}

	if name == indexFile {
		http.NotFound(w, r)

		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintln(w, "Frontend unavailable. Run make web.")
}

func serveStatic(w http.ResponseWriter, r *http.Request, web fs.FS, name string) bool {
	info, err := fs.Stat(web, name)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}

	switch {
	case name == "sw.js":
		w.Header().Set("Cache-Control", noCache)
	case strings.HasSuffix(name, ".webmanifest"):
		w.Header().Set("Cache-Control", noCache)
		w.Header().Set("Content-Type", "application/manifest+json")
	case strings.HasPrefix(name, "assets/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}

	//nolint:gosec // ValidPath restricts name to the embedded filesystem.
	http.ServeFileFS(w, r, web, name)

	return true
}
