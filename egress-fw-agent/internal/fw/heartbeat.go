// Package fw — periodic heartbeat publisher (ALT-27).
//
// Writes the agent's current health to the `egress-fw-health` JetStream
// KV bucket every 5s. The server-side health-status reader (Stage D10)
// reads the latest value and reports freshness via the existing UI.
//
// Single key per agent. Multi-fw-agent operators (theoretical — there's
// only ever one host-singleton) would key by hostname; today we use a
// fixed `current` key since one agent === one bucket.
package fw

import (
	"context"
	"log/slog"
	"time"

	"github.com/mrgeoffrich/mini-infra/egress-shared/natsbus"
)

const (
	healthBucket   = "egress-fw-health"
	healthKey      = "current"
	heartbeatEvery = 5 * time.Second
)

// HeartbeatPublisher writes a heartbeat to the egress-fw-health KV bucket
// on a fixed cadence. Reads `LastApplyId()` from the supplied accessor —
// usually the NatsHandler — so a re-applied agent's heartbeat advertises
// the most recent apply correlation id.
type HeartbeatPublisher struct {
	bus           *natsbus.Bus
	log           *slog.Logger
	lastApplyIdFn func() string
}

// NewHeartbeatPublisher constructs the publisher. `lastApplyIdFn` may be
// nil (the heartbeat just won't carry the field then).
func NewHeartbeatPublisher(
	bus *natsbus.Bus,
	log *slog.Logger,
	lastApplyIdFn func() string,
) *HeartbeatPublisher {
	return &HeartbeatPublisher{bus: bus, log: log, lastApplyIdFn: lastApplyIdFn}
}

// Run blocks until ctx is cancelled. Publishes the first heartbeat
// immediately (no warm-up gap on a fresh start), then on each tick.
//
// Errors from individual KV writes are logged at warn and ignored — the
// server compares wall-clock against `reportedAtMs` so a missed tick just
// means the next one is what the operator sees.
func (p *HeartbeatPublisher) Run(ctx context.Context) {
	p.log.Info("heartbeat publisher started", "bucket", healthBucket, "every", heartbeatEvery)
	p.publish() // emit the first heartbeat right away
	t := time.NewTicker(heartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			p.log.Info("heartbeat publisher stopped")
			return
		case <-t.C:
			p.publish()
		}
	}
}

func (p *HeartbeatPublisher) publish() {
	hb := natsbus.EgressFwHealth{
		Ok:           true,
		ReportedAtMs: time.Now().UnixMilli(),
	}
	if p.lastApplyIdFn != nil {
		if id := p.lastApplyIdFn(); id != "" {
			hb.LastApplyId = id
		}
	}
	if _, err := p.bus.KVPut(healthBucket, healthKey, hb); err != nil {
		// Don't log every miss at error — KV writes during a NATS
		// reconnect are expected to fail. Warn-level and move on; the
		// next tick will try again.
		p.log.Warn("heartbeat KV put failed", "err", err.Error())
	}
}
