// Package main runs a loopback-only OpenID provider for the Playwright tests.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/zekihan/go-commons/mockidp"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)

	err := mockidp.Run(ctx, os.Stdout)

	stop()

	if err != nil {
		slog.Error("Mock identity provider failed", slog.Any("error", err))
		os.Exit(1)
	}
}
