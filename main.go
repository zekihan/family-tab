package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zekihan/go-commons/backup"
	"github.com/zekihan/go-commons/log"
	"github.com/zekihan/go-commons/metrics"
	"github.com/zekihan/go-commons/middleware"
	"github.com/zekihan/go-commons/oidcauth"
	"github.com/zekihan/go-commons/utils"

	// IANA zones must resolve inside the distroless image.
	_ "time/tzdata"

	"github.com/zekihan/family-tab/internal/config"
	"github.com/zekihan/family-tab/internal/mcp"
	"github.com/zekihan/family-tab/internal/protocol"
	"github.com/zekihan/family-tab/internal/server"
	"github.com/zekihan/family-tab/internal/store"
	"github.com/zekihan/family-tab/internal/syncsvc"
	"github.com/zekihan/family-tab/web"
)

const (
	oidcHTTPTimeout   = 12 * time.Second
	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 120 * time.Second
	shutdownTimeout   = 10 * time.Second
)

func main() {
	err := run()
	if err != nil {
		slog.Error("Server failed", slog.Any("error", err))
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load(ctx)
	if err != nil {
		return fmt.Errorf("start: %w", err)
	}

	loggerConfig := new(log.LoggerConfig)
	loggerConfig.Level = cfg.LogLevel
	log.InitLogger(loggerConfig)
	utils.LogVersionInfo(ctx)

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer st.Close()

	authSvc, err := oidcauth.New(ctx, &oidcauth.Config[protocol.Me]{
		HTTPClient: &http.Client{
			Transport:     nil,
			CheckRedirect: nil,
			Jar:           nil,
			Timeout:       oidcHTTPTimeout,
		},
		SuccessPath:       "/",
		PublicURL:         cfg.PublicURL,
		Issuer:            cfg.OIDCIssuer,
		ClientID:          cfg.OIDCClientID,
		ClientSecret:      cfg.OIDCClientSecret,
		OwnerSubject:      cfg.BuyerSubject,
		MCPClientID:       cfg.MCPClientID,
		MCPAudience:       cfg.MCPAudience,
		AppName:           "Family Tab",
		SessionCookie:     "ft_session",
		TransactionCookie: "ft_oidc_tx",
		CookieInsecure:    cfg.CookieInsecure,
		Authorize: func(info oidcauth.IdentityInfo) (protocol.Me, bool) {
			return protocol.Me{Subject: info.Subject, Name: info.Name, Email: info.Email},
				info.Subject != ""
		},
	}, st.DB())
	if err != nil {
		return fmt.Errorf("init sign-in: %w", err)
	}

	webFS, err := web.DistFS()
	if err != nil {
		return fmt.Errorf("start: %w", err)
	}

	syncSvc := syncsvc.New(st, time.Now)

	srv := server.New(server.Deps{
		Auth: authSvc,
		Sync: syncSvc,
		MCP:  mcp.NewHandler(mcp.Deps{Ledger: syncSvc, Now: time.Now, Version: utils.Version}),
		Web:  webFS,
	})
	registry := srv.MetricsRegistry()

	if cfg.BackupDir != "" {
		go func() {
			backupErr := backup.Run(ctx, st.DB(), cfg.BackupDir, cfg.BackupInterval, cfg.BackupKeep,
				backup.WithFilePrefix("family-tab-"))
			if backupErr != nil && !errors.Is(backupErr, context.Canceled) {
				slog.ErrorContext(ctx, "Database backups stopped", slog.Any("error", backupErr))
			}
		}()
	}

	httpServer := new(http.Server)
	httpServer.Addr = cfg.ListenAddr
	httpServer.Handler = registry.Middleware(
		middleware.RecoverHandler(middleware.Logging(srv.Handler())),
	)
	httpServer.ReadHeaderTimeout = readHeaderTimeout
	httpServer.IdleTimeout = idleTimeout

	slog.InfoContext(ctx, "Listening", slog.String("addr", cfg.ListenAddr))

	if cfg.MetricsAddr != "" {
		slog.InfoContext(ctx, "Serving metrics", slog.String("addr", cfg.MetricsAddr))

		go serveMetrics(ctx, cfg.MetricsAddr, registry)
	}

	return serve(ctx, httpServer)
}

// serveMetrics runs the internal /metrics listener until ctx is canceled.
// An empty addr disables the listener. It is never served on the public
// ingress.
func serveMetrics(ctx context.Context, addr string, registry *metrics.Registry) {
	if addr == "" {
		return
	}

	err := registry.ListenAndServe(ctx, addr)
	if err != nil {
		slog.ErrorContext(ctx, "Metrics server failed", slog.Any("error", err))
	}
}

func serve(ctx context.Context, httpServer *http.Server) error {
	errCh := make(chan error, 1)

	go func() {
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}

		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()

	err := httpServer.Shutdown(shutdownCtx)
	if err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	return nil
}
