// Package main is the entry point for the egress-fw-agent binary.
//
// ALT-27: the primary control channel is now NATS. The agent subscribes
// to `mini-infra.egress.fw.rules.apply` (request/reply), publishes NFLOG
// drop events to JetStream `mini-infra.egress.fw.events`, and writes a
// 5 s heartbeat into the `egress-fw-health` KV bucket. The legacy Unix-
// socket admin API is kept compiled behind `MINI_INFRA_FW_AGENT_TRANSPORT=
// unix` for one release as a rollback path.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/mrgeoffrich/mini-infra/egress-fw-agent/internal/config"
	"github.com/mrgeoffrich/mini-infra/egress-fw-agent/internal/fw"
	applog "github.com/mrgeoffrich/mini-infra/egress-shared/log"
	"github.com/mrgeoffrich/mini-infra/egress-shared/natsbus"
	"github.com/mrgeoffrich/mini-infra/egress-shared/state"
)

func main() {
	log := applog.New()

	cfg := config.LoadAgentConfig()
	log.Info(
		"egress-fw-agent starting",
		"transport", string(cfg.Transport),
		"socket", cfg.SocketPath,
	)

	// Root context — cancelled on SIGTERM/SIGINT.
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer cancel()

	// Persistent env state (survives agent restart via reconcile on next boot).
	store := fw.NewEnvStore()

	// Boot-time reconcile: re-apply any rules already in kernel from prior run.
	reconciler := fw.NewReconciler(store, log)
	reconciler.ReconcileAll()

	// Container map — Phase 3 wires this to a NATS-pushed update; Phase 2
	// keeps it as a read-only stub. Lookups return nil for unknown IPs.
	containerMap := state.NewContainerMap()

	// Connect the bus when in NATS transport mode. The legacy "unix" mode
	// runs without a bus connection; NflogReader receives `nil` and
	// rate-limits a warn for any NFLOG drops it can't publish (the legacy
	// stdout path is gone — see the file comment in nflog.go).
	var bus *natsbus.Bus
	if cfg.Transport == config.TransportNats {
		var err error
		bus, err = natsbus.Connect(ctx, natsbus.ConnectOptions{
			URL:    cfg.NatsUrl,
			Creds:  cfg.NatsCreds,
			Name:   "mini-infra-fw-agent",
			Logger: log,
		})
		if err != nil {
			// Hard failure on first connect: under nats transport this is
			// what makes the container retry-loop visibly. The reconciler
			// has already replayed nftables rules, so the firewall stays
			// in place during the retry.
			log.Error("nats bus connect failed; exiting so the container restart-policy retries", "err", err.Error())
			os.Exit(1)
		}
		defer func() {
			if cerr := bus.Close(); cerr != nil {
				log.Warn("nats bus close failed", "err", cerr.Error())
			}
		}()
	}

	// NFLOG reader — bus is nil under transport=unix, in which case events
	// fall on the floor (a known limitation of the legacy fallback;
	// operators on rollback should also revert the server's ingester).
	nflogReader := fw.NewNflogReader(containerMap, log, bus)
	nflogErrCh := make(chan error, 1)
	go func() {
		if err := nflogReader.Run(ctx); err != nil {
			// NFLOG availability is an open spike on WSL2; log but don't
			// fatal. nftables rules are still enforced — only the
			// observability stream is missing.
			log.Warn("NFLOG reader stopped (kernel module may be unavailable on WSL2)", "err", err.Error())
		}
		nflogErrCh <- nil
	}()

	// Apply handler + heartbeat publisher under NATS transport. Both bind
	// to the bus singleton; the heartbeat reads `LastApplyId` so the
	// server can correlate "what's the most recent apply this agent
	// processed" without waiting for the next applied event.
	if cfg.Transport == config.TransportNats {
		handler := fw.NewNatsHandler(store, log, bus)
		sub, err := handler.Subscribe()
		if err != nil {
			log.Error("nats handler subscribe failed", "err", err.Error())
			os.Exit(1)
		}
		defer func() { _ = sub.Drain() }()
		log.Info("nats apply handler subscribed", "subject", natsbus.SubjectEgressFwRulesApply)

		hb := fw.NewHeartbeatPublisher(bus, log, handler.LastApplyId)
		go hb.Run(ctx)
	}

	// Legacy Unix-socket admin server — only under transport=unix.
	apiErrCh := make(chan error, 1)
	if cfg.Transport == config.TransportUnix {
		apiServer := fw.NewServer(cfg.SocketPath, store, log)
		go func() {
			apiErrCh <- apiServer.Run(ctx)
		}()
	}

	log.Info("egress-fw-agent ready")

	// Wait for shutdown signal or fatal error.
	select {
	case <-ctx.Done():
		log.Info("egress-fw-agent shutting down")
	case err := <-apiErrCh:
		if err != nil {
			log.Error("Admin API fatal error", "err", err.Error())
			os.Exit(1)
		}
	}
}
