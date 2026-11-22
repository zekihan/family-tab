// Package config loads the server configuration from environment variables.
package config

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/sethvargo/go-envconfig/v2"
)

type Config struct {
	// ListenAddr is the HTTP listen address.
	ListenAddr string `env:"LISTEN_ADDR, default=:8080"`
	// DBPath is the SQLite database file.
	DBPath string `env:"DB_PATH, default=./family-tab.db"`
	// BackupDir receives periodic VACUUM INTO copies of the database.
	BackupDir string `env:"BACKUP_DIR"`
	// PublicURL is the external origin, e.g. https://tab.example.com, used for
	// the OIDC redirect URL.
	PublicURL string `env:"PUBLIC_URL, required"`
	// OIDCIssuer is the provider issuer URL used for discovery.
	OIDCIssuer       string `env:"OIDC_ISSUER, required"`
	OIDCClientID     string `env:"OIDC_CLIENT_ID, required"`
	OIDCClientSecret string `env:"OIDC_CLIENT_SECRET"`
	// BuyerSubject is the `sub` of the only identity allowed in; the issuer
	// must equal OIDCIssuer.
	BuyerSubject string     `env:"BUYER_SUBJECT, required"`
	LogLevel     slog.Level `env:"LOG_LEVEL, default=INFO"`
	// BackupInterval is how often the database is copied to BackupDir.
	BackupInterval time.Duration `env:"BACKUP_INTERVAL, default=6h"`
	// BackupKeep is how many backup files to keep.
	BackupKeep int `env:"BACKUP_KEEP, default=28"`
	// CookieInsecure drops the Secure cookie attribute, for local HTTP
	// development only.
	CookieInsecure bool `env:"COOKIE_INSECURE, default=false"`
}

// Load reads the configuration from the environment.
func Load(ctx context.Context) (*Config, error) {
	cfg := new(Config)

	err := envconfig.Process(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}

	return cfg, nil
}
