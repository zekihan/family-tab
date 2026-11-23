package server

import (
	"github.com/zekihan/go-commons/metrics"
)

// MetricsRegistry returns the server's metrics registry, creating it on
// first use. The same registry backs the request middleware and the
// internal /metrics listener started by main.
func (srv *Server) MetricsRegistry() *metrics.Registry {
	srv.metricsMu.Lock()
	defer srv.metricsMu.Unlock()

	if srv.metricsReg == nil {
		srv.metricsReg = metrics.New()
	}

	return srv.metricsReg
}

// observeSyncOp records the outcome of one ledger sync operation.
// Operation names are fixed; outcomes are ok or error.
func (srv *Server) observeSyncOp(operation string, err error) {
	outcome := "ok"
	if err != nil {
		outcome = "error"
	}

	srv.MetricsRegistry().Counter("familytab_sync_operations_total", metrics.Labels{
		"operation": operation,
		"outcome":   outcome,
	}).Inc()
}

// observeHeadRevision tracks the latest ledger revision served.
func (srv *Server) observeHeadRevision(revision int64) {
	srv.MetricsRegistry().Gauge("familytab_ledger_head_revision", nil).Set(float64(revision))
}
