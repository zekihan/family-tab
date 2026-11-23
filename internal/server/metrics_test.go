package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
	"github.com/zekihan/family-tab/internal/syncsvc"
)

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
	handler := srv.Handler()

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

	registry := srv.MetricsRegistry()
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
}
