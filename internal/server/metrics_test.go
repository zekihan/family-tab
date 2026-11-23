package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zekihan/go-commons/middleware"

	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
	"github.com/zekihan/family-tab/internal/syncsvc"
)

type metricsMCPAuth struct{ fakeAuth }

func (metricsMCPAuth) MCPEnabled() bool { return true }

func TestMetricsRecordsMCPRoute(t *testing.T) {
	t.Parallel()

	srv := New(Deps{
		Auth: metricsMCPAuth{fakeAuth: fakeAuth{authenticated: true}},
		Sync: nil,
		MCP: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusAccepted)
		}),
		Web: nil,
	})
	registry := srv.MetricsRegistry()
	handler := registry.Middleware(
		middleware.RecoverHandler(middleware.Logging(srv.Handler())),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/mcp", http.NoBody),
	)

	if response.Code != http.StatusAccepted {
		t.Fatalf("MCP status = %d", response.Code)
	}

	recorder := httptest.NewRecorder()
	registry.Handler().ServeHTTP(
		recorder,
		httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/metrics", http.NoBody),
	)

	if !strings.Contains(
		recorder.Body.String(),
		`http_requests_total{method="POST",route="/mcp",status="202"} 1`,
	) {
		t.Fatalf("metrics exposition missing MCP route label:\n%s", recorder.Body.String())
	}
}

// TestMetricsRecordsSyncRequests serves one snapshot through the API and
// checks the server registry recorded it.
func TestMetricsRecordsSyncRequests(t *testing.T) {
	t.Parallel()

	db, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = db.Close() })

	srv := New(Deps{
		Auth: fakeAuth{authenticated: true},
		Sync: syncsvc.New(db, time.Now),
		MCP:  nil,
		Web:  nil,
	})
	registry := srv.MetricsRegistry()
	// Mirror the production chain from main.go so the route label is recorded
	// through the same middlewares.
	handler := registry.Middleware(
		middleware.RecoverHandler(middleware.Logging(srv.Handler())),
	)

	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		"/api/snapshot",
		http.NoBody,
	)
	request.Header.Set(protocol.HeaderName, protocol.HeaderValue)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d", response.Code)
	}

	if got := registry.Counter("familytab_sync_operations_total", map[string]string{
		"operation": "snapshot",
		"outcome":   "ok",
	}).Get(); got != 1 {
		t.Fatalf("snapshot operations recorded = %d, want 1", got)
	}

	recorder := httptest.NewRecorder()
	registry.Handler().ServeHTTP(
		recorder,
		httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/metrics", http.NoBody),
	)

	if !strings.Contains(recorder.Body.String(), "familytab_sync_operations_total") {
		t.Fatalf("metrics exposition missing sync operations:\n%s", recorder.Body.String())
	}

	if !strings.Contains(recorder.Body.String(), "familytab_ledger_head_revision") {
		t.Fatalf("metrics exposition missing head revision:\n%s", recorder.Body.String())
	}

	body := recorder.Body.String()
	if !strings.Contains(
		body,
		`http_requests_total{method="GET",route="/api/snapshot",status="200"}`,
	) {
		t.Fatalf("metrics exposition missing API route label:\n%s", body)
	}

	if strings.Contains(body, `route="unknown"`) {
		t.Fatalf("metrics exposition labels a request unknown:\n%s", body)
	}
}
