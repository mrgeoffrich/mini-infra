// Package natsbridge wires the egress-gateway to its NATS subjects.
//
// Phase 3 (ALT-28) replaced the gateway's :8054 admin HTTP listener and
// stdout decision log with three NATS surfaces:
//
//   - subscribe to `mini-infra.egress.gw.rules.apply.<envId>`         (req/reply, ACL push)
//   - subscribe to `mini-infra.egress.gw.container-map.apply.<envId>` (req/reply, container map push)
//   - publish to    `mini-infra.egress.gw.decisions`                  (JetStream, per-decision)
//   - publish to    KV bucket `egress-gw-health` keyed by envId       (5 s heartbeat)
//
// Every subscribe handler ack's its request via NATS reply-on-`msg.Reply`;
// the decisions publisher is JetStream-backed so a gateway crash mid-flight
// keeps the message in the stream until the server-side consumer acks it.
package natsbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/sirupsen/logrus"

	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/proxy"
	rulesstate "github.com/mrgeoffrich/mini-infra/egress-gateway/internal/state"
	"github.com/mrgeoffrich/mini-infra/egress-shared/natsbus"
	"github.com/mrgeoffrich/mini-infra/egress-shared/state"
)

// ---------------------------------------------------------------------------
// Wire types — mirror the Zod schemas in
// `server/src/services/nats/payload-schemas.ts`. The TS↔Go drift check (CI)
// only covers subject names; payload field names are protected by these
// JSON tags. Keep them in lock-step with the Zod definitions when fields
// change.
// ---------------------------------------------------------------------------

type rulesApplyRequest struct {
	EnvironmentID string                                `json:"environmentId"`
	Version       int                                   `json:"version"`
	StackPolicies map[string]proxy.StackPolicyEntry     `json:"stackPolicies"`
}

type rulesApplyReply struct {
	EnvironmentID string `json:"environmentId"`
	Version       int    `json:"version"`
	Accepted      bool   `json:"accepted"`
	RuleCount     int    `json:"ruleCount"`
	StackCount    int    `json:"stackCount"`
	Reason        string `json:"reason,omitempty"`
}

type containerMapEntry struct {
	IP          string `json:"ip"`
	StackID     string `json:"stackId"`
	ServiceName string `json:"serviceName"`
	ContainerID string `json:"containerId,omitempty"`
}

type containerMapApplyRequest struct {
	EnvironmentID string              `json:"environmentId"`
	Version       int                 `json:"version"`
	Entries       []containerMapEntry `json:"entries"`
}

type containerMapApplyReply struct {
	EnvironmentID string `json:"environmentId"`
	Version       int    `json:"version"`
	Accepted      bool   `json:"accepted"`
	EntryCount    int    `json:"entryCount"`
	Reason        string `json:"reason,omitempty"`
}

type heartbeat struct {
	EnvironmentID       string  `json:"environmentId"`
	ReportedAtMs        int64   `json:"reportedAtMs"`
	UptimeSeconds       float64 `json:"uptimeSeconds"`
	RulesVersion        int     `json:"rulesVersion"`
	ContainerMapVersion int     `json:"containerMapVersion"`
	Listeners           struct {
		Proxy bool `json:"proxy"`
	} `json:"listeners"`
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

// Options carry the runtime knobs main.go passes in. Everything except
// EnvironmentID and the ACL/container-map collaborators is optional.
type Options struct {
	Bus *natsbus.Bus
	// EnvironmentID is appended to per-env command/event subjects. Required.
	EnvironmentID string
	// AclSwapper installs a compiled ACL atomically when a rules.apply
	// request is accepted.
	AclSwapper *proxy.ACLSwapper
	// Containers is the in-memory container map fed by container-map.apply.
	Containers *state.ContainerMap
	// RulesState exposes the latest rules version for heartbeat reporting.
	RulesState *rulesstate.RulesState
	// ProxyUp is sampled by the heartbeat publisher. Pointer so it tracks
	// the live listener state without a ticker race.
	ProxyUp *atomic.Bool
	// Logger receives lifecycle and per-message logs. Required.
	Logger *logrus.Logger
}

// Bridge owns the NATS-side wiring. Closing it stops the heartbeat ticker
// and unsubscribes from the command subjects; main.go is responsible for
// closing the underlying `natsbus.Bus`.
type Bridge struct {
	opts             Options
	subRules         *nats.Subscription
	subContainerMap  *nats.Subscription
	heartbeatStop    chan struct{}
	startedAt        time.Time
	containerMapVer  atomic.Int64 // int64 so we can use atomic — server sends int
}

// New constructs a Bridge. Connect() does the actual subscribe + ticker work.
func New(opts Options) (*Bridge, error) {
	if opts.Bus == nil {
		return nil, fmt.Errorf("natsbridge: Bus is required")
	}
	if opts.EnvironmentID == "" {
		return nil, fmt.Errorf("natsbridge: EnvironmentID is required")
	}
	if opts.AclSwapper == nil || opts.Containers == nil || opts.RulesState == nil {
		return nil, fmt.Errorf("natsbridge: AclSwapper, Containers and RulesState are required")
	}
	if opts.Logger == nil {
		opts.Logger = logrus.New()
	}
	return &Bridge{
		opts:          opts,
		heartbeatStop: make(chan struct{}),
		startedAt:     time.Now(),
	}, nil
}

// Connect registers subscribers and starts the heartbeat. Idempotent — a
// second Connect on the same Bridge is a no-op.
func (b *Bridge) Connect() error {
	if b.subRules != nil {
		return nil
	}

	rulesSubject := fmt.Sprintf("%s.%s", natsbus.SubjectEgressGwRulesApply, b.opts.EnvironmentID)
	cmSubject := fmt.Sprintf("%s.%s", natsbus.SubjectEgressGwContainerMapApply, b.opts.EnvironmentID)

	subRules, err := b.opts.Bus.Respond(rulesSubject, b.handleRulesApply)
	if err != nil {
		return fmt.Errorf("natsbridge: subscribe %s: %w", rulesSubject, err)
	}
	b.subRules = subRules

	subCM, err := b.opts.Bus.Respond(cmSubject, b.handleContainerMapApply)
	if err != nil {
		_ = subRules.Unsubscribe()
		return fmt.Errorf("natsbridge: subscribe %s: %w", cmSubject, err)
	}
	b.subContainerMap = subCM

	go b.heartbeatLoop()

	b.opts.Logger.WithFields(logrus.Fields{
		"rulesSubject":        rulesSubject,
		"containerMapSubject": cmSubject,
		"environmentId":       b.opts.EnvironmentID,
	}).Info("natsbridge: subscribed to control plane subjects")

	return nil
}

// Close stops the heartbeat and unsubscribes. Idempotent.
func (b *Bridge) Close() {
	select {
	case <-b.heartbeatStop:
		// already closed
	default:
		close(b.heartbeatStop)
	}
	if b.subRules != nil {
		_ = b.subRules.Unsubscribe()
		b.subRules = nil
	}
	if b.subContainerMap != nil {
		_ = b.subContainerMap.Unsubscribe()
		b.subContainerMap = nil
	}
}

// ---------------------------------------------------------------------------
// Decisions emitter — main.go installs this on the logrus hook so canonical
// proxy-decision entries publish into the JetStream stream.
// ---------------------------------------------------------------------------

// DecisionEmitter returns a proxy.DecisionEmitter that publishes each event
// to `mini-infra.egress.gw.decisions` via JetStream. Errors are logged but
// never block the proxy hot path — JetStream's at-least-once guarantee
// covers transient failures, and the dedup window on the server-side
// consumer absorbs any duplicates from redelivery.
func (b *Bridge) DecisionEmitter() proxy.DecisionEmitter {
	return func(evt proxy.EgressEvent) {
		// Stamp the env id again as a safety net — the hook also stamps it,
		// but a hand-built event that bypasses the hook (currently none, but
		// defensive) would otherwise reach the server with an empty field
		// and be rejected by Zod.
		if evt.EnvironmentId == "" {
			evt.EnvironmentId = b.opts.EnvironmentID
		}
		// Bounded publish timeout so a stalled JetStream doesn't back-pressure
		// the proxy hot path. 2s is a wide margin vs typical sub-ms publish
		// time and tight enough to catch a wedged broker promptly. Phase 2's
		// JSPublishWithContext marshals the payload itself.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, err := b.opts.Bus.JSPublishWithContext(ctx, natsbus.SubjectEgressGwDecisions, evt); err != nil {
			b.opts.Logger.WithError(err).Warn("natsbridge: jetstream publish decision failed")
		}
	}
}

// ---------------------------------------------------------------------------
// Subject handlers
// ---------------------------------------------------------------------------

// Phase 2's `Bus.Respond` marshals the returned reply itself, so handlers
// return the typed struct as `any` and let the bus emit the JSON.

func (b *Bridge) handleRulesApply(msg *nats.Msg) (any, error) {
	var req rulesApplyRequest
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return rulesApplyReply{
			EnvironmentID: b.opts.EnvironmentID,
			Accepted:      false,
			Reason:        fmt.Sprintf("invalid payload: %v", err),
		}, nil
	}
	if req.EnvironmentID != b.opts.EnvironmentID {
		// Subject already routed it here, but the in-payload envId is the
		// authoritative check (defence in depth — a misconfigured allowlist
		// could otherwise let a foreign env's snapshot land here).
		return rulesApplyReply{
			EnvironmentID: b.opts.EnvironmentID,
			Version:       req.Version,
			Accepted:      false,
			Reason: fmt.Sprintf(
				"environmentId mismatch: subject is for %q, payload claims %q",
				b.opts.EnvironmentID, req.EnvironmentID),
		}, nil
	}

	snap := &proxy.RulesSnapshot{
		Version:       req.Version,
		StackPolicies: req.StackPolicies,
	}
	newACL, err := proxy.CompileACL(b.opts.Logger, snap)
	if err != nil {
		b.opts.Logger.WithError(err).Warn("natsbridge: compile ACL failed")
		return rulesApplyReply{
			EnvironmentID: b.opts.EnvironmentID,
			Version:       req.Version,
			Accepted:      false,
			Reason:        fmt.Sprintf("compile error: %v", err),
		}, nil
	}
	b.opts.AclSwapper.Swap(newACL)

	stackCount := len(snap.StackPolicies)
	ruleCount := 0
	for _, sp := range snap.StackPolicies {
		ruleCount += len(sp.Rules)
	}
	b.opts.RulesState.Set(snap.Version, stackCount)

	b.opts.Logger.WithFields(logrus.Fields{
		"version":    snap.Version,
		"stackCount": stackCount,
		"ruleCount":  ruleCount,
	}).Info("natsbridge: ACL updated via rules.apply")

	return rulesApplyReply{
		EnvironmentID: b.opts.EnvironmentID,
		Version:       snap.Version,
		Accepted:      true,
		RuleCount:     ruleCount,
		StackCount:    stackCount,
	}, nil
}

func (b *Bridge) handleContainerMapApply(msg *nats.Msg) (any, error) {
	var req containerMapApplyRequest
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return containerMapApplyReply{
			EnvironmentID: b.opts.EnvironmentID,
			Accepted:      false,
			Reason:        fmt.Sprintf("invalid payload: %v", err),
		}, nil
	}
	if req.EnvironmentID != b.opts.EnvironmentID {
		return containerMapApplyReply{
			EnvironmentID: b.opts.EnvironmentID,
			Version:       req.Version,
			Accepted:      false,
			Reason: fmt.Sprintf(
				"environmentId mismatch: subject is for %q, payload claims %q",
				b.opts.EnvironmentID, req.EnvironmentID),
		}, nil
	}

	snapshot := make(map[string]*state.ContainerAttr, len(req.Entries))
	for _, e := range req.Entries {
		snapshot[e.IP] = &state.ContainerAttr{
			StackID:     e.StackID,
			ServiceName: e.ServiceName,
		}
	}
	b.opts.Containers.Replace(snapshot)
	b.containerMapVer.Store(int64(req.Version))

	b.opts.Logger.WithFields(logrus.Fields{
		"version":    req.Version,
		"entryCount": len(req.Entries),
	}).Info("natsbridge: container map updated")

	return containerMapApplyReply{
		EnvironmentID: b.opts.EnvironmentID,
		Version:       req.Version,
		Accepted:      true,
		EntryCount:    len(req.Entries),
	}, nil
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

const heartbeatInterval = 5 * time.Second

func (b *Bridge) heartbeatLoop() {
	t := time.NewTicker(heartbeatInterval)
	defer t.Stop()
	// Send one immediately so the server gets a "we're up" signal before
	// the first interval elapses.
	b.publishHeartbeat()
	for {
		select {
		case <-b.heartbeatStop:
			return
		case <-t.C:
			b.publishHeartbeat()
		}
	}
}

func (b *Bridge) publishHeartbeat() {
	hb := heartbeat{
		EnvironmentID:       b.opts.EnvironmentID,
		ReportedAtMs:        time.Now().UnixMilli(),
		UptimeSeconds:       time.Since(b.startedAt).Seconds(),
		RulesVersion:        b.opts.RulesState.Version(),
		ContainerMapVersion: int(b.containerMapVer.Load()),
	}
	hb.Listeners.Proxy = b.opts.ProxyUp != nil && b.opts.ProxyUp.Load()
	// Phase 2's KVPut marshals the value itself.
	if _, err := b.opts.Bus.KVPut(natsbus.KvEgressGwHealth, b.opts.EnvironmentID, hb); err != nil {
		// The KV bucket may not exist on first boot; rather than fail the
		// loop, log at debug. The control plane creates the bucket on stack
		// apply for the egress-gateway template.
		b.opts.Logger.WithError(err).Debug("natsbridge: heartbeat KV put failed")
	}
}
