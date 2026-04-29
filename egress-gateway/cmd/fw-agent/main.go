// Package main is the entry point for the egress-fw-agent binary.
// It binds the Unix-socket admin API, starts the NFLOG reader, and runs
// the boot-time reconciler.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/config"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/fw"
	applog "github.com/mrgeoffrich/mini-infra/egress-gateway/internal/log"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/state"
)

func main() {
	log := applog.New()

	cfg := config.LoadAgentConfig()
	log.Info("egress-fw-agent starting", "socket", cfg.SocketPath)

	// Root context — cancelled on SIGTERM/SIGINT.
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer cancel()

	// Persistent env state (survives agent restart via reconcile on next boot).
	store := fw.NewEnvStore()

	// Boot-time reconcile: re-apply any rules already in kernel from prior run.
	reconciler := fw.NewReconciler(store, log)
	reconciler.ReconcileAll()

	// Container map — Phase 3 wires this to the admin API; Phase 2 is empty.
	containerMap := state.NewContainerMap()

	// Start admin API server (blocks in goroutine).
	apiServer := fw.NewServer(cfg.SocketPath, store, log)
	apiErrCh := make(chan error, 1)
	go func() {
		apiErrCh <- apiServer.Run(ctx)
	}()

	// Start NFLOG reader (blocks in goroutine).
	nflogReader := fw.NewNflogReader(containerMap, log)
	nflogErrCh := make(chan error, 1)
	go func() {
		if err := nflogReader.Run(ctx); err != nil {
			// NFLOG availability is an open spike on WSL2; log but don't fatal.
			log.Warn("NFLOG reader stopped (kernel module may be unavailable on WSL2)", "err", err)
		}
		nflogErrCh <- nil
	}()

	log.Info("egress-fw-agent ready")

	// Wait for shutdown signal or fatal error.
	select {
	case <-ctx.Done():
		log.Info("egress-fw-agent shutting down")
	case err := <-apiErrCh:
		if err != nil {
			log.Error("Admin API fatal error", "err", err)
			os.Exit(1)
		}
	}
}
