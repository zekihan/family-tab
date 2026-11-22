// Package main runs a loopback-only OpenID provider for the Playwright tests.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/oauth2-proxy/mockoidc"
)

func main() {
	port := flag.String("port", "18081", "loopback port")
	subject := flag.String("subject", "family-tab-buyer", "default OIDC subject")

	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)

	err := run(ctx, *port, *subject)

	stop()

	if err != nil {
		slog.Error("Mock identity provider failed", slog.Any("error", err))
		os.Exit(1)
	}
}

func run(ctx context.Context, port, subject string) error {
	provider, err := mockoidc.NewServer(nil)
	if err != nil {
		return fmt.Errorf("create provider: %w", err)
	}

	err = provider.AddMiddleware(selectUser(provider, subject))
	if err != nil {
		return fmt.Errorf("configure test users: %w", err)
	}

	var listenConfig net.ListenConfig

	listener, err := listenConfig.Listen(ctx, "tcp4", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		return fmt.Errorf("listen on loopback: %w", err)
	}
	defer listener.Close()

	err = provider.Start(listener, nil)
	if err != nil {
		return fmt.Errorf("start provider: %w", err)
	}
	defer func() {
		shutdownErr := provider.Shutdown()
		if shutdownErr != nil {
			slog.ErrorContext(
				ctx,
				"Mock identity provider shutdown failed",
				slog.Any("error", shutdownErr),
			)
		}
	}()

	err = json.NewEncoder(os.Stdout).Encode(provider.Config())
	if err != nil {
		return fmt.Errorf("print provider configuration: %w", err)
	}

	<-ctx.Done()

	return nil
}

func selectUser(provider *mockoidc.MockOIDC, subject string) func(http.Handler) http.Handler {
	var authorize sync.Mutex

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != mockoidc.AuthorizationEndpoint {
				next.ServeHTTP(w, r)

				return
			}

			// Keep the selected user paired with this authorization request.
			authorize.Lock()
			defer authorize.Unlock()

			user := mockoidc.DefaultUser()
			user.Subject = subject

			_, err := r.Cookie("mockoidc-other-user")
			if err == nil {
				user.Subject += "-other"
			}

			provider.QueueUser(user)
			next.ServeHTTP(w, r)
			// Clear the choice even if the request failed before consuming it.
			_ = provider.UserQueue.Pop()
		})
	}
}
