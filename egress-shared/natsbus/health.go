// Package natsbus — shared out-of-band agent health surface (Phase 3).
//
// Both egress binaries expose an identical local HTTP `GET /healthz` reporting
// their NATS connection state (§4.2). Defining the payload shape and the
// handler here — rather than in each binary's `internal/` — keeps the two
// agents in lock-step and gives the server a single JSON contract to scrape,
// mirroring how the NATS payloads themselves live in this shared module.
//
// This is deliberately independent of the in-band `egress-*-health` KV
// heartbeat: the heartbeat needs a working NATS link to publish, so it cannot
// report an auth failure. `/healthz` is served over the agent's own HTTP
// listener and therefore stays reachable even when NATS auth is broken — which
// is the whole point of the phase.
package natsbus

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// HealthReport is the JSON body returned by an agent's `GET /healthz`. It is
// the Go source of truth for the shape consumed by the TS
// `EgressAgentHealthReport` type in `@mini-infra/types` and the scraper in
// `server/src/services/egress/agent-health-scraper.ts`.
type HealthReport struct {
	// Status is the §4.2 connection state:
	// connected | reconnecting | auth-failed | disconnected.
	Status ConnState `json:"status"`
	// LastHeartbeatAgeMs is the age, in milliseconds, of the most recent in-band
	// KV heartbeat this process published successfully. -1 when the agent has
	// not yet landed a heartbeat (still starting, or NATS never came up).
	LastHeartbeatAgeMs int64 `json:"lastHeartbeatAgeMs"`
}

// BuildHealthReport snapshots the current health from a Bus plus an optional
// last-heartbeat-age accessor (the heartbeat publisher tracks its own last
// successful put). A nil bus reports disconnected; a nil age accessor reports
// -1 ("never").
func BuildHealthReport(bus *Bus, lastHeartbeatAge func() int64) HealthReport {
	state := ConnStateDisconnected
	if bus != nil {
		state = bus.ConnState()
	}
	age := int64(-1)
	if lastHeartbeatAge != nil {
		age = lastHeartbeatAge()
	}
	return HealthReport{Status: state, LastHeartbeatAgeMs: age}
}

// HealthHandler returns an http.HandlerFunc that serves the health report as
// JSON. It always responds 200 — the state lives in the payload, not the
// status code, so a scraper that only inspects the code doesn't collapse
// "auth-failed" into a generic "unreachable".
func HealthHandler(bus *Bus, lastHeartbeatAge func() int64) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		rep := BuildHealthReport(bus, lastHeartbeatAge)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(rep)
	}
}

// ServeHealth runs a minimal HTTP server exposing `GET /healthz` on addr until
// ctx is cancelled. Both egress binaries call this so the transport and shape
// stay identical. Blocking — run it in a goroutine. Returns nil on clean
// shutdown (ctx cancelled), or the ListenAndServe error otherwise.
func ServeHealth(ctx context.Context, addr string, bus *Bus, lastHeartbeatAge func() int64, log *slog.Logger) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", HealthHandler(bus, lastHeartbeatAge))
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if log != nil {
		log.Info("agent health server listening", "addr", addr, "path", "/healthz")
	}
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
