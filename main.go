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

	"github.com/zekihan/go-commons/middleware"
	"github.com/zekihan/go-commons/utils"

	// IANA zones must resolve inside the distroless image.
	_ "time/tzdata"

	"github.com/zekihan/family-tab/internal/auth"
	"github.com/zekihan/family-tab/internal/backup"
	"github.com/zekihan/family-tab/internal/config"
	"github.com/zekihan/family-tab/internal/server"
	"github.com/zekihan/family-tab/internal/store"
	"github.com/zekihan/family-tab/internal/syncsvc"
	"github.com/zekihan/family-tab/web"
)

const (
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

	loggerConfig := new(utils.LoggerConfig)
	loggerConfig.Level = cfg.LogLevel
	utils.InitLogger(loggerConfig)
	utils.LogVersionInfo(ctx)

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer st.Close()

	authSvc, err := auth.New(ctx, &auth.Config{
		PublicURL:      cfg.PublicURL,
		Issuer:         cfg.OIDCIssuer,
		ClientID:       cfg.OIDCClientID,
		ClientSecret:   cfg.OIDCClientSecret,
		BuyerSubject:   cfg.BuyerSubject,
		CookieInsecure: cfg.CookieInsecure,
	}, st.DB())
	if err != nil {
		return fmt.Errorf("init sign-in: %w", err)
	}

	webFS, err := web.DistFS()
	if err != nil {
		return fmt.Errorf("start: %w", err)
	}

	srv := server.New(server.Deps{
		Auth: authSvc,
		Sync: syncsvc.New(st, time.Now),
		Web:  webFS,
	})

	if cfg.BackupDir != "" {
		go func() {
			backupErr := backup.Run(ctx, st.DB(), cfg.BackupDir, cfg.BackupInterval, cfg.BackupKeep)
			if backupErr != nil && !errors.Is(backupErr, context.Canceled) {
				slog.ErrorContext(ctx, "Database backups stopped", slog.Any("error", backupErr))
			}
		}()
	}

	httpServer := new(http.Server)
	httpServer.Addr = cfg.ListenAddr
	httpServer.Handler = middleware.RecoverHandler(middleware.Logging(srv.Handler()))
	httpServer.ReadHeaderTimeout = readHeaderTimeout
	httpServer.IdleTimeout = idleTimeout

	slog.InfoContext(ctx, "Listening", slog.String("addr", cfg.ListenAddr))

	return serve(ctx, httpServer)
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
