// Package mcp serves the ledger to the buyer's chat agent over the Model
// Context Protocol (docs/PROTOCOL.md section 9). Every write is a normal
// operation committed through syncsvc with source agent.
package mcp

import (
	"net/http"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/zekihan/family-tab/internal/syncsvc"
)

const (
	serverName     = "family-tab"
	defaultVersion = "dev"
	// MaxRequestBody caps one JSON-RPC request. Tool inputs are small.
	maxRequestBody = 1 << 20
)

const serverInstructions = "Family Tab is the buyer's ledger of what family members owe for things the " +
	"buyer bought for them. Amounts are Turkish lira (TRY) strings such as \"1.299,90\"; results " +
	"give both integer kuruş (...Minor) and formatted text. Dates are YYYY-MM-DD in the ledger " +
	"time zone. Get personId values from list_people or find_person; never guess a person or " +
	"create one. Ask the buyer before writing anything you are unsure about."

// Deps are the collaborators of the MCP server.
type Deps struct {
	Ledger *syncsvc.Service
	// Now is the clock for today's date, operation timestamps and the Undo window.
	Now func() time.Time
	// Version is the build version reported to clients. Empty means "dev".
	Version string
}

type service struct {
	ledger *syncsvc.Service
	now    func() time.Time
}

// NewHandler returns the streamable HTTP handler for /mcp. It does no
// authentication of its own; mount it behind the bearer middleware.
func NewHandler(deps Deps) http.Handler {
	svc := &service{ledger: deps.Ledger, now: deps.Now}

	version := deps.Version
	if version == "" {
		version = defaultVersion
	}

	implementation := new(sdk.Implementation)
	implementation.Name = serverName
	implementation.Version = version

	serverOptions := new(sdk.ServerOptions)
	serverOptions.Instructions = serverInstructions
	// The catalog is fixed for the life of the process. Keep tool discovery
	// enabled without holding open streams for tool-list changes.
	serverOptions.Capabilities = new(sdk.ServerCapabilities)
	serverOptions.Capabilities.Tools = new(sdk.ToolCapabilities)

	server := sdk.NewServer(implementation, serverOptions)
	svc.register(server)

	transport := new(sdk.StreamableHTTPOptions)
	transport.Stateless = true
	transport.JSONResponse = true
	// The bearer token already authenticates every request, and the listener is
	// commonly reached through a local reverse proxy, where the SDK's loopback
	// Host check would reject real requests.
	transport.DisableLocalhostProtection = true
	transport.MaxRequestBodyBytes = maxRequestBody

	return sdk.NewStreamableHTTPHandler(
		func(*http.Request) *sdk.Server { return server },
		transport,
	)
}
