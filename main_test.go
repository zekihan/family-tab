package main

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestServeShutsDownOnCancel(t *testing.T) {
	t.Parallel()

	server := new(http.Server)
	server.Addr = "127.0.0.1:0"
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)

	go func() { done <- serve(ctx, server) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not shut down after cancellation")
	}
}

func TestServeReportsListenFailure(t *testing.T) {
	t.Parallel()

	server := new(http.Server)
	server.Addr = "256.256.256.256:99999"
	server.Handler = http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})

	err := serve(t.Context(), server)
	if err == nil {
		t.Fatal("expected a listen error")
	}
}
