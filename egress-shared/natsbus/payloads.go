// Package natsbus payloads — Go-side mirror of the Zod schemas in
// `server/src/services/nats/payload-schemas.ts`. JSON tags are the source
// of truth for wire compatibility with the TS bus.
//
// Validation is intentionally minimal: the server-side Zod schemas are the
// strict end and reject anything the agent sends that doesn't conform. The
// agent's responsibility is just to produce well-formed payloads — these
// structs do that by virtue of their typed fields. Inputs the agent
// receives over Subscribe/Request similarly assume the server-side bus
// validated on publish.
//
// **Round-trip tested.** `payloads_test.go` round-trips each shape through
// JSON to catch silent drift between the Go and TS sides.

package natsbus

// EgressFwApplyOp is the discriminator for `EgressFwRulesApplyRequest`.
//
// Mirrors the TS `op` literal union exactly. Adding an op here without
// extending the server-side Zod discriminated union will fail validation
// at the receiver — the test pins this.
type EgressFwApplyOp string

const (
	OpEnvUpsert EgressFwApplyOp = "env-upsert"
	OpEnvRemove EgressFwApplyOp = "env-remove"
	OpIpsetAdd  EgressFwApplyOp = "ipset-add"
	OpIpsetDel  EgressFwApplyOp = "ipset-del"
	OpIpsetSync EgressFwApplyOp = "ipset-sync"
)

// FwMode mirrors the TS `fwMode` enum.
type FwMode string

const (
	FwModeObserve FwMode = "observe"
	FwModeEnforce FwMode = "enforce"
)

// EgressFwRulesApplyRequest is the wire shape of `mini-infra.egress.fw.rules.apply`.
//
// All variants share `ApplyId`, `Op`, and `EnvName`. Variant-specific fields
// are omitempty so a single struct can carry every op without bloating the
// JSON for the simpler variants. Mirrors the TS discriminated union — the
// receiver dispatches on `Op`.
type EgressFwRulesApplyRequest struct {
	ApplyId string          `json:"applyId"`
	Op      EgressFwApplyOp `json:"op"`
	EnvName string          `json:"envName"`
	// env-upsert
	BridgeCidr string `json:"bridgeCidr,omitempty"`
	Mode       FwMode `json:"mode,omitempty"`
	// ipset-add / ipset-del
	Ip string `json:"ip,omitempty"`
	// ipset-sync — nil for non-sync ops, empty slice means "clear all".
	Ips []string `json:"ips,omitempty"`
}

// EgressFwRulesApplyReply mirrors the TS reply schema.
type EgressFwRulesApplyReply struct {
	ApplyId string `json:"applyId"`
	Status  string `json:"status"` // "applied" | "rejected"
	Reason  string `json:"reason,omitempty"`
}

// EgressFwRulesApplied is the past-tense fan-out event published after a
// successful apply. Lands on JetStream `EgressFwEvents`.
type EgressFwRulesApplied struct {
	ApplyId     string          `json:"applyId"`
	Op          EgressFwApplyOp `json:"op"`
	EnvName     string          `json:"envName"`
	AppliedAtMs int64           `json:"appliedAtMs"`
	DurationMs  int64           `json:"durationMs"`
}

// EgressFwEvent is the NFLOG-derived drop/observe event. JSON-friendly
// re-typing of the legacy stdout `fw_drop` JSON line shape.
//
// Optional fields use pointers so they emit `null` when set explicitly to
// nothing, and disappear from the wire when unset (omitempty). The Zod
// counterpart treats them as `optional()` — same effect.
type EgressFwEvent struct {
	OccurredAtMs int64   `json:"occurredAtMs"`
	Protocol     string  `json:"protocol"` // "tcp" | "udp" | "icmp"
	SrcIp        string  `json:"srcIp"`
	DestIp       string  `json:"destIp"`
	DestPort     *uint16 `json:"destPort,omitempty"`
	StackId      string  `json:"stackId,omitempty"`
	ServiceName  string  `json:"serviceName,omitempty"`
	Reason       string  `json:"reason,omitempty"`
	MergedHits   uint32  `json:"mergedHits"`
}

// EgressFwHealth is the periodic heartbeat published into the `egress-fw-health`
// KV bucket. The server reads the latest value to compute health-UI freshness.
type EgressFwHealth struct {
	Ok           bool   `json:"ok"`
	ReportedAtMs int64  `json:"reportedAtMs"`
	QueueDepth   *int   `json:"queueDepth,omitempty"`
	LastApplyId  string `json:"lastApplyId,omitempty"`
}
