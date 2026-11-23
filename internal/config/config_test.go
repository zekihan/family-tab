package config

import (
	"maps"
	"testing"

	"github.com/sethvargo/go-envconfig/v2"
)

func baseEnv(extra map[string]string) map[string]string {
	env := map[string]string{
		"PUBLIC_URL":     "https://tab.example/",
		"OIDC_ISSUER":    "https://auth.example",
		"OIDC_CLIENT_ID": "family-tab",
		"BUYER_SUBJECT":  "buyer",
	}
	maps.Copy(env, extra)

	return env
}

func TestDefaults(t *testing.T) {
	t.Parallel()

	cfg, err := load(t.Context(), envconfig.MapLookuper(baseEnv(nil)))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.ListenAddr != ":8080" || cfg.MetricsAddr != ":9090" || cfg.DBPath != "./family-tab.db" ||
		cfg.BackupDir != "" ||
		cfg.OIDCClientSecret != "" || cfg.MCPClientID != "" ||
		cfg.MCPAudience != "https://tab.example/mcp" || cfg.LogLevel.String() != "INFO" ||
		cfg.BackupInterval.String() != "6h0m0s" || cfg.BackupKeep != 28 || cfg.CookieInsecure {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestParseErrors(t *testing.T) {
	t.Parallel()

	cases := map[string]map[string]string{
		"invalid log level":       {"LOG_LEVEL": "VERBOSE"},
		"invalid backup interval": {"BACKUP_INTERVAL": "soon"},
		"invalid backup keep":     {"BACKUP_KEEP": "many"},
		"invalid cookie insecure": {"COOKIE_INSECURE": "yes"},
	}

	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			_, err := load(t.Context(), envconfig.MapLookuper(baseEnv(extra)))
			if err == nil {
				t.Fatal("expected a config error")
			}
		})
	}

	t.Run("missing required value", func(t *testing.T) {
		t.Parallel()

		env := baseEnv(nil)
		delete(env, "BUYER_SUBJECT")

		_, err := load(t.Context(), envconfig.MapLookuper(env))
		if err == nil {
			t.Fatal("expected a config error for a missing required value")
		}
	})
}

func TestMCPAudience(t *testing.T) {
	t.Parallel()

	cases := []struct {
		env  map[string]string
		name string
		want string
		ok   bool
	}{
		{name: "disabled default", env: nil, want: "https://tab.example/mcp", ok: true},
		{
			name: "enabled default",
			env:  map[string]string{"MCP_CLIENT_ID": "claude"},
			want: "https://tab.example/mcp",
			ok:   true,
		},
		{
			name: "explicit",
			env: map[string]string{
				"MCP_CLIENT_ID": "claude",
				"MCP_AUDIENCE":  "https://api.example/mcp",
			},
			want: "https://api.example/mcp",
			ok:   true,
		},
		{
			name: "http rejected",
			env: map[string]string{
				"MCP_CLIENT_ID": "claude",
				"MCP_AUDIENCE":  "http://tab.example/mcp",
			},
			want: "",
			ok:   false,
		},
		{
			name: "http allowed in insecure dev mode",
			env: map[string]string{
				"MCP_CLIENT_ID":   "claude",
				"MCP_AUDIENCE":    "http://localhost:8080/mcp",
				"COOKIE_INSECURE": "true",
			},
			want: "http://localhost:8080/mcp",
			ok:   true,
		},
		{
			name: "relative rejected",
			env:  map[string]string{"MCP_CLIENT_ID": "claude", "MCP_AUDIENCE": "/mcp"},
			want: "",
			ok:   false,
		},
		{
			name: "fragment rejected",
			env: map[string]string{
				"MCP_CLIENT_ID": "claude",
				"MCP_AUDIENCE":  "https://tab.example/mcp#x",
			},
			want: "",
			ok:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cfg, err := load(t.Context(), envconfig.MapLookuper(baseEnv(tc.env)))
			if !tc.ok {
				if err == nil {
					t.Fatal("expected an error")
				}

				return
			}

			if err != nil {
				t.Fatal(err)
			}

			if cfg.MCPAudience != tc.want {
				t.Fatalf("MCPAudience = %q, want %q", cfg.MCPAudience, tc.want)
			}
		})
	}
}
