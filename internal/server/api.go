package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"

	"github.com/zekihan/go-commons/metrics"
	"github.com/zekihan/go-commons/oidcauth"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
)

const (
	mediaJSON      = "application/json"
	maxRequestBody = 8 << 20
)

type apiRoute struct {
	handler http.Handler
	method  string
}

func (srv *Server) apiHandler() http.Handler {
	requireSession := srv.deps.Auth.RequireSession
	routes := map[string]apiRoute{
		"/api/logout": {
			withoutPayload(srv.deps.Auth.LogoutHandler()), http.MethodPost,
		},
		"/api/me": {
			requireSession(withoutPayload(http.HandlerFunc(me))), http.MethodGet,
		},
		"/api/snapshot": {
			requireSession(withoutPayload(http.HandlerFunc(srv.snapshot))), http.MethodGet,
		},
		"/api/sync/receipts": {
			requireSession(jsonEndpoint(srv.deps.Sync.Receipts)), http.MethodPost,
		},
		"/api/sync/ops": {
			requireSession(jsonEndpoint(srv.apply)), http.MethodPost,
		},
		"/api/restore": {
			requireSession(jsonEndpoint(srv.restore)), http.MethodPost,
		},
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")

		if r.Header.Get(protocol.HeaderName) != protocol.HeaderValue {
			writeError(
				w,
				http.StatusForbidden,
				"forbidden",
				"Missing or invalid X-Family-Tab header.",
			)

			return
		}

		route, ok := routes[r.URL.Path]
		if !ok {
			writeError(w, http.StatusNotFound, "not_found", "API route not found.")

			return
		}

		if route.method != r.Method {
			w.Header().Set("Allow", route.method)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")

			return
		}

		// The route table is fixed, so the path is a bounded label value.
		route.handler.ServeHTTP(w, metrics.WithRoute(r, r.URL.Path))
	})
}

func me(w http.ResponseWriter, r *http.Request) {
	identity, ok := oidcauth.Identity[protocol.Me](r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "Sign in is required.")

		return
	}

	writeJSON(w, http.StatusOK, identity)
}

func (srv *Server) snapshot(w http.ResponseWriter, r *http.Request) {
	value, err := srv.deps.Sync.Snapshot(r.Context())
	srv.observeSyncOp("snapshot", err)

	if err == nil {
		srv.observeHeadRevision(value.Revision)
	}

	writeResult(w, r, value, err)
}

type restoreRequest struct {
	ExpectedRevision *int64          `json:"expectedRevision"`
	OpID             string          `json:"opId"`
	Backup           json.RawMessage `json:"backup"`
}

// complete reports whether every required field was supplied; JSON null or
// an omitted expectedRevision would otherwise decode as revision 0.
func (req *restoreRequest) complete() bool {
	return req.ExpectedRevision != nil && *req.ExpectedRevision >= 0 && req.OpID != "" &&
		len(req.Backup) > 0 && !bytes.Equal(req.Backup, []byte("null"))
}

// completeRequest is implemented by requests with fields that must be present.
type completeRequest interface {
	complete() bool
}

func (srv *Server) restore(
	ctx context.Context,
	req *restoreRequest,
) (*protocol.RestoreResult, error) {
	restore := new(protocol.RestoreRequest)
	restore.RawBackup = req.Backup
	restore.OpID = req.OpID
	restore.ExpectedRevision = *req.ExpectedRevision

	value, err := srv.deps.Sync.Restore(ctx, restore)
	srv.observeSyncOp("restore", err)

	if err != nil {
		return nil, fmt.Errorf("restore backup: %w", err)
	}

	srv.observeHeadRevision(value.Revision)

	return value, nil
}

type opsResponse struct {
	Generation string `json:"generation"`
	Results    []any  `json:"results"`
}

func (srv *Server) apply(ctx context.Context, req *protocol.OpsRequest) (*opsResponse, error) {
	value, err := srv.deps.Sync.Apply(ctx, req, ledger.SourceApp)
	srv.observeSyncOp("apply", err)

	if err != nil {
		return nil, fmt.Errorf("apply sync batch: %w", err)
	}

	response := &opsResponse{
		Generation: value.Generation,
		Results:    make([]any, 0, len(value.Results)),
	}
	for index := range value.Results {
		result := &value.Results[index]
		switch result.Status {
		case protocol.StatusSkipped, protocol.StatusHeld:
			response.Results = append(response.Results, result)
		default:
			// Committed results use the full Receipt shape, including zeroes,
			// empty arrays and nulls. OpResult omits those fields.
			response.Results = append(response.Results, (*protocol.Receipt)(result))
		}
	}

	return response, nil
}

func jsonEndpoint[Request, Response any](
	run func(context.Context, *Request) (*Response, error),
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readJSON(w, r, true)
		if !ok {
			return
		}

		req := new(Request)
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()

		err := decoder.Decode(req)
		if err != nil || body[0] != '{' {
			writeError(w, http.StatusBadRequest, "invalid", "Expected a JSON request object.")

			return
		}

		if check, ok := any(req).(completeRequest); ok && !check.complete() {
			writeError(
				w,
				http.StatusBadRequest,
				"invalid",
				"The request is missing a required field.",
			)

			return
		}

		value, err := run(r.Context(), req)
		writeResult(w, r, value, err)
	}
}

func withoutPayload(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, ok := readJSON(w, r, false)
		if ok {
			next.ServeHTTP(w, r)
		}
	})
}

func readJSON(w http.ResponseWriter, r *http.Request, required bool) ([]byte, bool) {
	if r.Body == nil || r.Body == http.NoBody {
		if required {
			writeError(w, http.StatusBadRequest, "invalid", "Expected a JSON body.")
		}

		return nil, !required
	}

	if r.ContentLength > maxRequestBody {
		writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "Request exceeds 8 MiB.")

		return nil, false
	}

	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != mediaJSON {
		writeError(
			w,
			http.StatusUnsupportedMediaType,
			"invalid_content_type",
			"Expected application/json.",
		)

		return nil, false
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	body, err := io.ReadAll(r.Body)

	if _, tooLarge := errors.AsType[*http.MaxBytesError](err); tooLarge {
		writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "Request exceeds 8 MiB.")

		return nil, false
	}

	body = bytes.TrimSpace(body)
	if err != nil || !json.Valid(body) {
		writeError(w, http.StatusBadRequest, "invalid", "Expected a valid JSON body.")

		return nil, false
	}

	return body, true
}

func writeResult(w http.ResponseWriter, r *http.Request, value any, err error) {
	if err != nil {
		slog.ErrorContext(r.Context(), "API request failed", slog.Any("error", err))
		writeError(
			w,
			http.StatusInternalServerError,
			"internal_error",
			"The request could not be completed.",
		)

		return
	}

	writeJSON(w, http.StatusOK, value)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", mediaJSON)
	w.WriteHeader(status)

	err := json.NewEncoder(w).Encode(value)
	if err != nil {
		slog.Error("Failed to encode API response", slog.Any("error", err))
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, protocol.ErrorResponse{Error: code, Message: message})
}
