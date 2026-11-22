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
