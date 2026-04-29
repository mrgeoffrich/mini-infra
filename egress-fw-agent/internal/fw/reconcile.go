// Package fw manages host firewall rules for the egress-fw-agent.
// This file implements boot-time reconciliation.
package fw

import (
	"log/slog"
)

// Reconciler applies stored env state to the kernel on agent startup.
// It ensures that if the agent restarts against an existing kernel ruleset,
// the desired state is re-applied idempotently.
type Reconciler struct {
	store *EnvStore
	log   *slog.Logger
}

// NewReconciler creates a new Reconciler.
func NewReconciler(store *EnvStore, log *slog.Logger) *Reconciler {
	return &Reconciler{store: store, log: log}
}

// ReconcileAll re-applies all known env rules to the kernel.
// Called on agent boot and on request.
func (r *Reconciler) ReconcileAll() {
	r.store.mu.RLock()
	snapshot := make(map[string]EnvState, len(r.store.envs))
	for k, v := range r.store.envs {
		snapshot[k] = v
	}
	r.store.mu.RUnlock()

	for env, state := range snapshot {
		r.log.Info("Reconciling env firewall rules", "env", env, "mode", state.Mode)

		if err := ensureIpset(env); err != nil {
			r.log.Error("Reconcile: ensureIpset failed", "env", env, "err", err)
			continue
		}
		if err := applyEnvRules(env, state.BridgeCIDR, state.Mode); err != nil {
			r.log.Error("Reconcile: applyEnvRules failed", "env", env, "err", err)
		}
	}
}
