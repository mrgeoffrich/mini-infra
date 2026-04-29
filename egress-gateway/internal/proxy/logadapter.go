package proxy

import (
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// EgressEvent is the NDJSON shape written to stdout for the log ingester.
// The `evt` field is always "tcp"; protocol is "connect" (HTTPS CONNECT) or "http".
type EgressEvent struct {
	Evt            string  `json:"evt"`            // always "tcp"
	Protocol       string  `json:"protocol"`       // "connect" | "http"
	Ts             string  `json:"ts"`             // RFC3339Nano
	SrcIp          string  `json:"srcIp"`
	Target         string  `json:"target"`         // host:port for CONNECT, hostname for HTTP
	Method         *string `json:"method,omitempty"` // HTTP method (HTTP forward only)
	Path           *string `json:"path,omitempty"`   // request path (HTTP forward only)
	Status         *int    `json:"status,omitempty"` // response status (HTTP forward only)
	Action         string  `json:"action"`         // "allowed" | "blocked"
	Reason         string  `json:"reason"`         // e.g. "rule-deny", "ip-literal", "doh-denied"
	MatchedPattern *string `json:"matchedPattern,omitempty"`
	StackId        *string `json:"stackId,omitempty"`
	ServiceName    *string `json:"serviceName,omitempty"`
	BytesUp        int64   `json:"bytesUp"`
	BytesDown      int64   `json:"bytesDown"`
	MergedHits     int     `json:"mergedHits"`
}

var stdoutMu sync.Mutex

// emitEgressEvent writes an EgressEvent as NDJSON to stdout.
// Writes are serialised to prevent interleaved output.
func emitEgressEvent(evt EgressEvent) {
	if evt.Ts == "" {
		evt.Ts = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if evt.MergedHits == 0 {
		evt.MergedHits = 1
	}
	b, err := json.Marshal(evt)
	if err != nil {
		return
	}
	b = append(b, '\n')
	stdoutMu.Lock()
	_, _ = os.Stdout.Write(b)
	stdoutMu.Unlock()
}

// toInt64 safely converts numeric logrus field values to int64.
// Logrus may store numeric values as int64, int, float64 (*uint64 for conntrack
// byte counters), or *uint64 pointer depending on the subsystem.
func toInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case int:
		return int64(x), true
	case float64:
		return int64(x), true
	case uint64:
		return int64(x), true
	case *uint64:
		if x != nil {
			return int64(*x), true
		}
		return 0, false
	default:
		return 0, false
	}
}

// NDJSONLogHook is a logrus.Hook that intercepts Smokescreen's canonical log
// entries and re-emits them as EgressEvent NDJSON on stdout for the ingester.
//
// Smokescreen emits two canonical log messages:
//   - "CANONICAL-PROXY-DECISION" — one per request at Info (allow) or Warn (deny).
//     For HTTP forward proxying this carries the content-length of the response.
//   - "CANONICAL-PROXY-CN-CLOSE" — one per HTTPS CONNECT tunnel at close time.
//     Carries bytes_in / bytes_out byte counts for the tunnel lifetime.
//
// Fields read from CANONICAL-PROXY-DECISION (smokescreen.LogField* constants):
//   - "inbound_remote_addr"  → SrcIp
//   - "requested_host"       → Target
//   - "allow"                → Action (bool → "allowed"/"blocked")
//   - "decision_reason"      → Reason
//   - "role"                 → StackId
//   - "proxy_type"           → Protocol ("http" vs "connect")
//   - "content_length"       → BytesDown (http.Response.ContentLength, int64)
//
// Fields read from CANONICAL-PROXY-CN-CLOSE (conntrack.LogField* constants):
//   - "bytes_in"             → BytesUp   (*uint64 pointer)
//   - "bytes_out"            → BytesDown (*uint64 pointer)
//   - "inbound_remote_addr"  → SrcIp
//   - "requested_host"       → Target
//   - "role"                 → StackId
type NDJSONLogHook struct{}

// Levels returns the logrus levels that should trigger this hook.
// Info covers allowed decisions; Warn covers denied decisions.
func (h *NDJSONLogHook) Levels() []logrus.Level {
	return []logrus.Level{logrus.InfoLevel, logrus.WarnLevel, logrus.ErrorLevel}
}

// Fire is called by logrus for each matching log entry.
func (h *NDJSONLogHook) Fire(entry *logrus.Entry) error {
	switch entry.Message {
	case "CANONICAL-PROXY-DECISION":
		h.handleDecision(entry)
	case "CANONICAL-PROXY-CN-CLOSE":
		h.handleConnClose(entry)
	}
	return nil
}

// handleDecision handles CANONICAL-PROXY-DECISION log entries (HTTP forward
// and CONNECT decision events). This fires once per request at decision time
// and carries response content-length for HTTP forward proxying.
func (h *NDJSONLogHook) handleDecision(entry *logrus.Entry) {
	evt := EgressEvent{
		Evt:        "tcp",
		MergedHits: 1,
	}

	// Determine protocol ("http" vs "connect").
	// Smokescreen sets proxy_type to the proxy style.
	proxyType, _ := entry.Data["proxy_type"].(string)
	if proxyType == "http" {
		evt.Protocol = "http"
	} else {
		// CONNECT (HTTPS tunnel) or unknown — default to "connect"
		evt.Protocol = "connect"
	}

	// Source IP
	if v, ok := entry.Data["inbound_remote_addr"].(string); ok {
		evt.SrcIp = v
	}

	// Target host
	if v, ok := entry.Data["requested_host"].(string); ok {
		evt.Target = v
	}

	// Action
	if v, ok := entry.Data["allow"].(bool); ok && v {
		evt.Action = "allowed"
	} else {
		evt.Action = "blocked"
	}

	// Reason
	if v, ok := entry.Data["decision_reason"].(string); ok {
		evt.Reason = v
	}

	// Stack / service (role maps to stackId in our container map integration)
	if v, ok := entry.Data["role"].(string); ok && v != "" {
		s := v
		evt.StackId = &s
	}

	// Byte counts — smokescreen logs content_length (http.Response.ContentLength,
	// type int64) on HTTP forward proxy responses.
	if v, ok := toInt64(entry.Data["content_length"]); ok && v > 0 {
		evt.BytesDown = v
	}

	emitEgressEvent(evt)
}

// handleConnClose handles CANONICAL-PROXY-CN-CLOSE log entries. This fires
// when an HTTPS CONNECT tunnel closes and carries the total bytes transferred
// through the tunnel in both directions.
func (h *NDJSONLogHook) handleConnClose(entry *logrus.Entry) {
	evt := EgressEvent{
		Evt:        "tcp",
		Protocol:   "connect",
		MergedHits: 1,
	}

	// Source IP
	if v, ok := entry.Data["inbound_remote_addr"].(string); ok {
		evt.SrcIp = v
	}

	// Target host
	if v, ok := entry.Data["requested_host"].(string); ok {
		evt.Target = v
	}

	// Stack identity
	if v, ok := entry.Data["role"].(string); ok && v != "" {
		s := v
		evt.StackId = &s
	}

	// Action — CN-CLOSE only fires for established (allowed) tunnels.
	evt.Action = "allowed"

	// Byte counts — conntrack stores *uint64 pointers for bytes_in / bytes_out.
	// bytes_in  = bytes read from the client (upstream direction)
	// bytes_out = bytes written to the client (downstream direction)
	if v, ok := toInt64(entry.Data["bytes_in"]); ok {
		evt.BytesUp = v
	}
	if v, ok := toInt64(entry.Data["bytes_out"]); ok {
		evt.BytesDown = v
	}

	emitEgressEvent(evt)
}

// NewNDJSONLogHook constructs the hook.
func NewNDJSONLogHook() *NDJSONLogHook {
	return &NDJSONLogHook{}
}
