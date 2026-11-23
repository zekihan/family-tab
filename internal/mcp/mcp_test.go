package mcp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestToolListSubscriptionCompletes(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(NewHandler(Deps{Ledger: nil, Now: time.Now, Version: "test"}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()

	const version = "2026-07-28"

	const body = `{
		"jsonrpc":"2.0",
		"id":1,
		"method":"subscriptions/listen",
		"params":{
			"_meta":{
				"io.modelcontextprotocol/protocolVersion":"` + version + `",
				"io.modelcontextprotocol/clientInfo":{"name":"test","version":"1"},
				"io.modelcontextprotocol/clientCapabilities":{}
			},
			"notifications":{"toolsListChanged":true}
		}
	}`

	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		server.URL+"/mcp",
		strings.NewReader(body),
	)
	if err != nil {
		t.Fatal(err)
	}

	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Mcp-Protocol-Version", version)
	request.Header.Set("Mcp-Method", "subscriptions/listen")

	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = response.Body.Close() }()

	events, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("reading subscription until EOF: %v", err)
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("subscription status = %d, body = %s", response.StatusCode, events)
	}

	stream := string(events)
	if !strings.Contains(stream, `"method":"notifications/subscriptions/acknowledged"`) ||
		strings.Contains(stream, `"toolsListChanged":true`) ||
		!strings.Contains(stream, `"result":`) {
		t.Fatalf(
			"expected an acknowledgement declining tool-list changes followed by a result, got %s",
			stream,
		)
	}
}
