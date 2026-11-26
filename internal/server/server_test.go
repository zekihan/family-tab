package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/google/uuid"

	"github.com/zekihan/family-tab/internal/ledger"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/store"
	"github.com/zekihan/family-tab/internal/syncsvc"
)

type fakeAuth struct {
	authenticated bool
}

func (fakeAuth) LoginHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusFound)
	})
}

func (auth fakeAuth) CallbackHandler() http.Handler { return auth.LoginHandler() }

func (fakeAuth) LogoutHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
}

func (auth fakeAuth) RequireSession(next http.Handler) http.Handler {
	if auth.authenticated {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "Fake auth requires a session.")
	})
}

func (fakeAuth) MCPEnabled() bool { return false }

func (fakeAuth) RequireBearer(next http.Handler) http.Handler { return next }

func (fakeAuth) ProtectedResourceHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestRoutingAndHeaders(t *testing.T) {
	t.Parallel()

	handler := New(Deps{
		Auth: fakeAuth{authenticated: false},
		Sync: nil,
		MCP:  nil,
		Web: fstest.MapFS{
			"index.html":           webFile("<!doctype html><title>Family Tab</title>"),
			"sw.js":                webFile("// service worker"),
			"manifest.webmanifest": webFile("{}"),
			"assets/app.js":        webFile("// frontend"),
		},
	}).Handler()

	cases := []struct {
		path, method, header, body, cache string
		status                            int
	}{
		{"/api/snapshot", http.MethodGet, "", "forbidden", "no-store", http.StatusForbidden},
		{"/api//snapshot", http.MethodPost, "", "forbidden", "no-store", http.StatusForbidden},
		{"/api/logout", http.MethodOptions, "", "forbidden", "no-store", http.StatusForbidden},
		{
			"/api/snapshot",
			http.MethodGet,
			"1",
			"Fake auth requires a session.",
			"no-store",
			http.StatusUnauthorized,
		},
		{
			"/api/snapshot",
			http.MethodPost,
			"1",
			"method_not_allowed",
			"no-store",
			http.StatusMethodNotAllowed,
		},
		{"/api/unknown", http.MethodGet, "1", "not_found", "no-store", http.StatusNotFound},
		{"/api/logout", http.MethodPost, "1", "", "no-store", http.StatusNoContent},
		{"/auth/login", http.MethodGet, "", "", "", http.StatusFound},
		{"/auth/callback", http.MethodGet, "", "", "", http.StatusFound},
		{"/auth/unknown", http.MethodGet, "", "404", "", http.StatusNotFound},
		{"/healthz", http.MethodGet, "", "OK", "no-store", http.StatusOK},
		{"/person/123", http.MethodGet, "", "<title>Family Tab</title>", "no-cache", http.StatusOK},
		{"/index.html", http.MethodGet, "", "<title>Family Tab</title>", "no-cache", http.StatusOK},
		{"/sw.js", http.MethodGet, "", "service worker", "no-cache", http.StatusOK},
		{"/manifest.webmanifest", http.MethodGet, "", "{}", "no-cache", http.StatusOK},
		{"/assets/missing.js", http.MethodGet, "", "404", "", http.StatusNotFound},
		{"/assets/missing", http.MethodGet, "", "404", "", http.StatusNotFound},
		{"/favicon.png", http.MethodGet, "", "404", "", http.StatusNotFound},
		{
			"/assets/app.js",
			http.MethodGet,
			"",
			"frontend",
			"public, max-age=31536000, immutable",
			http.StatusOK,
		},
	}

	for _, test := range cases {
		request := httptest.NewRequestWithContext(t.Context(), test.method, test.path, http.NoBody)
		request.Header.Set("Origin", "https://other.example")
		request.Header.Set(protocol.HeaderName, test.header)

		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != test.status || !strings.Contains(response.Body.String(), test.body) {
			t.Errorf("%s %s with header %q: %d %s", test.method, test.path, test.header,
				response.Code, response.Body)
		}

		if got := response.Header().Get("Cache-Control"); got != test.cache {
			t.Errorf("%s cache-control %q, want %q", test.path, got, test.cache)
		}

		checkSecurityHeaders(t, response.Header())
	}
}

func checkSecurityHeaders(t *testing.T, header http.Header) {
	t.Helper()

	for key, want := range map[string]string{
		"Content-Security-Policy": contentSecurityPolicy,
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "same-origin",
	} {
		if got := header.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}

	for name := range header {
		if strings.HasPrefix(name, "Access-Control-") {
			t.Errorf("unexpected CORS header %s", name)
		}
	}
}

func TestPlaceholder(t *testing.T) {
	t.Parallel()

	handler := New(Deps{
		Auth: fakeAuth{authenticated: false}, Sync: nil, MCP: nil,
		Web: fstest.MapFS{".gitkeep": webFile("")},
	}).Handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", http.NoBody),
	)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "make web") {
		t.Fatalf("placeholder returned %d %s", response.Code, response.Body)
	}
}

func TestMeAndSnapshotRoutes(t *testing.T) {
	t.Parallel()

	handler, _ := testAPI(t)

	meRequest := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/me", http.NoBody)
	meRequest.Header.Set(protocol.HeaderName, protocol.HeaderValue)

	meResponse := httptest.NewRecorder()
	handler.ServeHTTP(meResponse, meRequest)
	expectError(t, meResponse, http.StatusUnauthorized, "unauthenticated")

	snapshotRequest := httptest.NewRequestWithContext(
		t.Context(), http.MethodGet, "/api/snapshot", http.NoBody,
	)
	snapshotRequest.Header.Set(protocol.HeaderName, protocol.HeaderValue)

	snapshotResponse := httptest.NewRecorder()
	handler.ServeHTTP(snapshotResponse, snapshotRequest)

	if snapshotResponse.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d, body %s", snapshotResponse.Code, snapshotResponse.Body)
	}

	var snapshot protocol.Snapshot

	err := json.NewDecoder(snapshotResponse.Body).Decode(&snapshot)
	if err != nil || snapshot.Generation == "" {
		t.Fatalf("snapshot = %+v, decode error %v", snapshot, err)
	}
}

func expectError(
	t *testing.T, response *httptest.ResponseRecorder, status int, code string,
) {
	t.Helper()

	var body protocol.ErrorResponse

	err := json.NewDecoder(response.Body).Decode(&body)
	if response.Code != status || err != nil || body.Error != code || body.Message == "" {
		t.Fatalf("response = %d %+v, decode error %v", response.Code, body, err)
	}
}

func TestJSONRequests(t *testing.T) {
	t.Parallel()

	handler, _ := testAPI(t)
	oversized := strings.Repeat(" ", maxRequestBody+1)

	tests := []struct {
		name, contentType, body string
		status                  int
		unknownLength           bool
	}{
		{"wrong type", "text/plain", "{}", http.StatusUnsupportedMediaType, false},
		{"non-object", mediaJSON, "null", http.StatusBadRequest, false},
		{"two values", mediaJSON, "{} {}", http.StatusBadRequest, false},
		{"unknown key", mediaJSON, `{"foo":1}`, http.StatusBadRequest, false},
		{"large known length", mediaJSON, oversized, http.StatusRequestEntityTooLarge, false},
		{"large streamed body", mediaJSON, oversized, http.StatusRequestEntityTooLarge, true},
		{"valid", mediaJSON + "; charset=utf-8", `{"opIds":[]}`, http.StatusOK, false},
	}

	for _, test := range tests {
		request := httptest.NewRequestWithContext(t.Context(),
			http.MethodPost,
			"/api/sync/receipts",
			strings.NewReader(test.body),
		)
		request.Header.Set(protocol.HeaderName, "1")
		request.Header.Set("Content-Type", test.contentType)

		if test.unknownLength {
			request.ContentLength = -1
		}

		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != test.status || response.Header().Get("Content-Type") != mediaJSON ||
			!json.Valid(response.Body.Bytes()) {
			t.Errorf("%s returned %d %s", test.name, response.Code, response.Body)
		}
	}
}

func TestRestoreRejectsMalformedBackupFields(t *testing.T) {
	t.Parallel()

	body := `{"opId":"` + uuid.NewString() + `","expectedRevision":0,"backup":{
		"format":"family-tab-backup","formatVersion":1,"exportedAt":"2026-01-01T00:00:00Z",
		"currency":"TRY","timeZone":"UTC",
		"people":[{"id":"00000000-0000-4000-8000-000000000001","name":"Mom","payday":null,"archived":false,"aliases":[]}],
		"purchases":[],"payments":[],"refunds":[],"payouts":[],
		"unapplied":[{"order":0,"reason":null,"dependencies":[],"op":{
			"id":"00000000-0000-4000-8000-000000000002","generation":"before",
			"createdAt":"2026-01-01T00:00:00Z","kind":"update","recordType":"person",
			"recordId":"00000000-0000-4000-8000-000000000001","baseVersion":"previous","patch":{"payday":15}
		}}]
	}}`

	for _, test := range []struct {
		name, old, replacement string
	}{
		{"invalid time zone", `"timeZone":"UTC"`, `"timeZone":"Factory"`},
		{"missing payday", `"payday":null,`, ""},
		{"missing archived", `,"archived":false`, ""},
		{"missing aliases", `,"aliases":[]`, ""},
		{"null aliases", `"aliases":[]`, `"aliases":null`},
		{"invalid alias", `"aliases":[]`, `"aliases":[" Mom "]`},
		{"unknown record field", `"archived":false`, `"archived":false,"extra":null`},
		{"missing order", `"order":0,`, ""},
		{"null order", `"order":0`, `"order":null`},
		{"missing reason", `"reason":null,`, ""},
		{"missing dependencies", `"dependencies":[],`, ""},
		{"false alreadyReturned on person", `"recordType":"person",`, `"recordType":"person","alreadyReturned":false,`},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			handler, svc := testAPI(t)

			before, err := svc.Snapshot(t.Context())
			if err != nil {
				t.Fatal(err)
			}

			result := postRestore(t, handler, strings.Replace(body, test.old, test.replacement, 1))
			if result.Status != protocol.StatusRejected || result.Code == nil ||
				*result.Code != ledger.CodeInvalid {
				t.Fatalf("unexpected restore result: %+v", result)
			}

			after, err := svc.Snapshot(t.Context())
			if err != nil || !reflect.DeepEqual(after, before) {
				t.Fatalf("malformed backup changed the ledger: %+v, error %v", after, err)
			}
		})
	}

	handler, _ := testAPI(t)

	if result := postRestore(t, handler, body); result.Status != protocol.StatusApplied {
		t.Fatalf("valid backup without a record version was rejected: %+v", result)
	}
}

func TestRestoreRequiresExpectedRevision(t *testing.T) {
	t.Parallel()

	handler, svc := testAPI(t)

	before, err := svc.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	backup := `{"format":"family-tab-backup","formatVersion":1,"exportedAt":"2026-01-01T00:00:00Z",
		"currency":"TRY","timeZone":"UTC","people":[],"purchases":[],"payments":[],"refunds":[],
		"payouts":[],"unapplied":[]}`

	for name, body := range map[string]string{
		"null revision":    `{"opId":"` + uuid.NewString() + `","expectedRevision":null,"backup":` + backup + `}`,
		"missing revision": `{"opId":"` + uuid.NewString() + `","backup":` + backup + `}`,
		"negative revision": `{"opId":"` + uuid.NewString() + `","expectedRevision":-1,"backup":` +
			backup + `}`,
		"missing backup": `{"opId":"` + uuid.NewString() + `","expectedRevision":0}`,
		"null backup":    `{"opId":"` + uuid.NewString() + `","expectedRevision":0,"backup":null}`,
	} {
		request := httptest.NewRequestWithContext(
			t.Context(), http.MethodPost, "/api/restore", strings.NewReader(body),
		)
		request.Header.Set(protocol.HeaderName, protocol.HeaderValue)
		request.Header.Set("Content-Type", mediaJSON)

		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusBadRequest {
			t.Errorf("%s returned %d %s", name, response.Code, response.Body)
		}
	}

	after, err := svc.Snapshot(t.Context())
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("incomplete restore request changed the ledger: %+v, error %v", after, err)
	}

	explicitZero := `{"opId":"` + uuid.NewString() + `","expectedRevision":0,"backup":` + backup + `}`
	if result := postRestore(t, handler, explicitZero); result.Status != protocol.StatusApplied {
		t.Fatalf("explicit revision 0 was rejected: %+v", result)
	}
}

func postRestore(t *testing.T, handler http.Handler, body string) *protocol.RestoreResult {
	t.Helper()

	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodPost, "/api/restore", strings.NewReader(body),
	)
	request.Header.Set(protocol.HeaderName, protocol.HeaderValue)
	request.Header.Set("Content-Type", mediaJSON)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	result := new(protocol.RestoreResult)

	err := json.Unmarshal(response.Body.Bytes(), result)
	if response.Code != http.StatusOK || err != nil {
		t.Fatalf("restore returned %d %s, decode error %v", response.Code, response.Body, err)
	}

	return result
}

func TestOperationWireReceipt(t *testing.T) {
	t.Parallel()

	handler, svc := testAPI(t)

	snapshot, err := svc.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	req := protocol.OpsRequest{Items: []protocol.OpsItem{{
		Op: protocol.Operation{
			ID:              uuid.NewString(),
			Generation:      snapshot.Generation,
			Kind:            ledger.KindCreate,
			BaseVersion:     nil,
			CreatedAt:       "",
			Record:          nil,
			Patch:           nil,
			PreImage:        nil,
			AlreadyReturned: false,
			RecordType:      ledger.TypePerson,
			RecordID:        uuid.NewString(),
		},
		Deps: nil,
	}}}

	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequestWithContext(t.Context(),
		http.MethodPost,
		"/api/sync/ops",
		strings.NewReader(string(body)),
	)
	request.Header.Set(protocol.HeaderName, "1")
	request.Header.Set("Content-Type", mediaJSON)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	var actual struct {
		Results []map[string]json.RawMessage `json:"results"`
	}

	err = json.Unmarshal(response.Body.Bytes(), &actual)
	if err != nil || response.Code != http.StatusOK || len(actual.Results) != 1 {
		t.Fatalf("unexpected operation response %d %s: %v", response.Code, response.Body, err)
	}

	result := actual.Results[0]
	for field, want := range map[string]string{
		"status": `"rejected"`, "code": `"not_setup"`, "current": "null", "blocking": "[]", "revision": "0",
	} {
		if got := string(result[field]); got != want {
			t.Errorf("%s = %s, want %s", field, got, want)
		}
	}

	receipts, err := svc.Receipts(
		t.Context(),
		&protocol.ReceiptsRequest{OpIDs: []string{req.Items[0].Op.ID}},
	)
	if err != nil || len(receipts.Receipts) != 1 {
		t.Fatalf("lookup = %+v: %v", receipts, err)
	}

	var receipt protocol.Receipt

	err = json.Unmarshal(response.Body.Bytes(), &struct {
		Results []*protocol.Receipt `json:"results"`
	}{Results: []*protocol.Receipt{&receipt}})
	if err != nil || !reflect.DeepEqual(receipt, receipts.Receipts[0]) {
		t.Fatalf("wire receipt = %+v, stored %+v, error %v", receipt, receipts.Receipts[0], err)
	}
}

func webFile(content string) *fstest.MapFile {
	return &fstest.MapFile{Data: []byte(content), Mode: 0, ModTime: time.Time{}, Sys: nil}
}

func testAPI(t *testing.T) (http.Handler, *syncsvc.Service) {
	t.Helper()

	db, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = db.Close() })

	svc := syncsvc.New(db, time.Now)
	handler := New(
		Deps{Auth: fakeAuth{authenticated: true}, Sync: svc, MCP: nil, Web: nil},
	).Handler()

	return handler, svc
}
