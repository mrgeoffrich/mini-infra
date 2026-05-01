// Package fw — NATS handler for the rules.apply command (ALT-27).
//
// Replaces the Unix-socket admin API in `api.go`. Subscribes to
// `mini-infra.egress.fw.rules.apply` and dispatches on the `op` field of
// the request body to the same package-private apply helpers (
// applyEnvRules, removeEnvRules, ensureIpset, addManagedMember, etc.) the
// HTTP handler already calls. Reusing those helpers keeps the actual
// nftables/ipset semantics single-sourced — only the transport changes.
//
// On success the handler:
//   1. Replies on `_INBOX.<auto>` with a typed `applied` envelope.
//   2. Publishes a past-tense `rules.applied` event on the durable
//      `EgressFwEvents` JetStream stream — fan-out for audit/metrics.
//
// On failure the reply carries `status: "rejected"` + a free-form reason.
// The applied event is NOT published on failure; subscribers that count
// applied-vs-rejected can use the absence of the event as the negative.
package fw

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/mrgeoffrich/mini-infra/egress-shared/natsbus"
	"github.com/nats-io/nats.go"
)

// NatsHandler subscribes to the apply command subject and dispatches each
// request onto the package's existing apply helpers.
type NatsHandler struct {
	store *EnvStore
	log   *slog.Logger
	bus   *natsbus.Bus

	// lastApplyId is read by the heartbeat publisher so the server can see
	// "what's the most recent apply this agent processed". Mutex over a
	// string is fine — apply rate is single-digit/sec at the high end.
	mu          sync.RWMutex
	lastApplyId string
}

// NewNatsHandler returns a handler bound to the given store, logger, bus.
func NewNatsHandler(store *EnvStore, log *slog.Logger, bus *natsbus.Bus) *NatsHandler {
	return &NatsHandler{store: store, log: log, bus: bus}
}

// Subscribe attaches the rules.apply responder. Returns the underlying
// nats.Subscription so the caller can hold it for the process lifetime.
func (h *NatsHandler) Subscribe() (*nats.Subscription, error) {
	return h.bus.Respond(natsbus.SubjectEgressFwRulesApply, h.handle)
}

// LastApplyId returns the applyId of the most recently processed request,
// or "" if none yet. Used by the heartbeat publisher.
func (h *NatsHandler) LastApplyId() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.lastApplyId
}

func (h *NatsHandler) recordApplyId(id string) {
	h.mu.Lock()
	h.lastApplyId = id
	h.mu.Unlock()
}

func (h *NatsHandler) handle(msg *nats.Msg) (any, error) {
	start := time.Now()
	var req natsbus.EgressFwRulesApplyRequest
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		// Reply schema requires applyId; we don't have one when JSON parse
		// fails, so leave it empty. The server-side request validator
		// should never let a body this malformed reach us — log warn so a
		// real occurrence is visible.
		h.log.Warn("rules.apply: invalid JSON body", "err", err.Error())
		return natsbus.EgressFwRulesApplyReply{
			ApplyId: "",
			Status:  "rejected",
			Reason:  "invalid JSON: " + err.Error(),
		}, nil
	}
	h.recordApplyId(req.ApplyId)

	if err := h.dispatch(req); err != nil {
		h.log.Error(
			"rules.apply rejected",
			"applyId", req.ApplyId,
			"op", string(req.Op),
			"env", req.EnvName,
			"err", err.Error(),
		)
		return natsbus.EgressFwRulesApplyReply{
			ApplyId: req.ApplyId,
			Status:  "rejected",
			Reason:  err.Error(),
		}, nil
	}

	durationMs := time.Since(start).Milliseconds()
	// Best-effort applied event — never fail the reply if JS publish hiccups.
	// The server doesn't depend on the event for the apply round-trip; it
	// only uses the event stream for audit/metrics.
	if _, perr := h.bus.JSPublish(
		natsbus.SubjectEgressFwRulesApplied,
		natsbus.EgressFwRulesApplied{
			ApplyId:     req.ApplyId,
			Op:          req.Op,
			EnvName:     req.EnvName,
			AppliedAtMs: time.Now().UnixMilli(),
			DurationMs:  durationMs,
		},
	); perr != nil {
		h.log.Warn(
			"rules.applied event publish failed (apply itself succeeded)",
			"applyId", req.ApplyId,
			"err", perr.Error(),
		)
	}

	return natsbus.EgressFwRulesApplyReply{
		ApplyId: req.ApplyId,
		Status:  "applied",
	}, nil
}

// dispatch routes an apply request to the matching package helper. Returns
// the first error from validation or apply; nil on success.
func (h *NatsHandler) dispatch(req natsbus.EgressFwRulesApplyRequest) error {
	if err := validateEnvName(req.EnvName); err != nil {
		return fmt.Errorf("envName: %w", err)
	}

	switch req.Op {
	case natsbus.OpEnvUpsert:
		mode, err := validateMode(string(req.Mode))
		if err != nil {
			return fmt.Errorf("mode: %w", err)
		}
		_, bridgeCIDR, err := validateBridgeCIDR(req.BridgeCidr)
		if err != nil {
			return fmt.Errorf("bridgeCidr: %w", err)
		}
		cidrStr := bridgeCIDR.String()
		if err := ensureIpset(req.EnvName); err != nil {
			return fmt.Errorf("ensureIpset: %w", err)
		}
		if err := applyEnvRules(req.EnvName, cidrStr, mode); err != nil {
			return fmt.Errorf("applyEnvRules: %w", err)
		}
		h.store.Set(req.EnvName, EnvState{BridgeCIDR: cidrStr, Mode: mode})
		return nil

	case natsbus.OpEnvRemove:
		if err := removeEnvRules(req.EnvName); err != nil {
			return fmt.Errorf("removeEnvRules: %w", err)
		}
		if err := destroyIpset(req.EnvName); err != nil {
			return fmt.Errorf("destroyIpset: %w", err)
		}
		h.store.Delete(req.EnvName)
		return nil

	case natsbus.OpIpsetAdd, natsbus.OpIpsetDel, natsbus.OpIpsetSync:
		envState, ok := h.store.Get(req.EnvName)
		if !ok {
			return fmt.Errorf("env not registered — send op=env-upsert first")
		}
		_, bridgeCIDR, err := net.ParseCIDR(envState.BridgeCIDR)
		if err != nil {
			return fmt.Errorf("invalid stored bridgeCidr: %w", err)
		}
		switch req.Op {
		case natsbus.OpIpsetAdd:
			if err := validateManagedIP(req.Ip, bridgeCIDR); err != nil {
				return fmt.Errorf("ip: %w", err)
			}
			return addManagedMember(req.EnvName, req.Ip)
		case natsbus.OpIpsetDel:
			if err := validateManagedIP(req.Ip, bridgeCIDR); err != nil {
				return fmt.Errorf("ip: %w", err)
			}
			return delManagedMember(req.EnvName, req.Ip)
		case natsbus.OpIpsetSync:
			for _, ip := range req.Ips {
				if err := validateManagedIP(ip, bridgeCIDR); err != nil {
					return fmt.Errorf("ips entry %q: %w", ip, err)
				}
			}
			return syncManaged(req.EnvName, req.Ips)
		}
		// Unreachable — outer switch covers all three.
		return fmt.Errorf("unreachable: %s", req.Op)

	default:
		return fmt.Errorf("unknown op %q", req.Op)
	}
}
