// Package config loads the server configuration from environment variables.
package config

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
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
	BuyerSubject string `env:"BUYER_SUBJECT, required"`
	// MCPClientID is the OAuth client whose access tokens may call /mcp. MCP is
	// disabled when empty.
	MCPClientID string `env:"MCP_CLIENT_ID"`
	// MCPAudience is the resource identifier access tokens must be issued for.
	// Defaults to PublicURL + "/mcp".
	MCPAudience string     `env:"MCP_AUDIENCE"`
	LogLevel    slog.Level `env:"LOG_LEVEL, default=INFO"`
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
	return load(ctx, envconfig.OsLookuper())
}

func load(ctx context.Context, lookuper envconfig.Lookuper) (*Config, error) {
	cfg := new(Config)

	err := envconfig.ProcessWith(ctx, &envconfig.Config{
		Target:             cfg,
		Lookuper:           lookuper,
		DefaultDelimiter:   "",
		DefaultSeparator:   "",
		DefaultNoInit:      false,
		DefaultOverwrite:   false,
		DefaultDecodeUnset: false,
		DefaultRequired:    false,
		Mutators:           nil,
	})
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}

	if cfg.MCPAudience == "" {
		cfg.MCPAudience = strings.TrimRight(cfg.PublicURL, "/") + "/mcp"
	}

	if cfg.MCPClientID != "" {
		err = validateAudience(cfg.MCPAudience, cfg.CookieInsecure)
		if err != nil {
			return nil, fmt.Errorf("load config: %w", err)
		}
	}

	return cfg, nil
}

var errInvalidAudience = errors.New(
	"MCP_AUDIENCE must be an absolute https URL without a fragment",
)

func validateAudience(audience string, insecure bool) error {
	parsed, err := url.Parse(audience)
	if err != nil || parsed.Host == "" || parsed.Fragment != "" || parsed.User != nil ||
		(parsed.Scheme != "https" && (!insecure || parsed.Scheme != "http")) {
		return errInvalidAudience
	}

	return nil
}
