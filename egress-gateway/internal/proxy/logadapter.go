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

// NDJSONLogHook is a logrus.Hook that intercepts Smokescreen's canonical log
// entries and re-emits them as EgressEvent NDJSON on stdout for the ingester.
//
// Smokescreen emits one "CANONICAL-PROXY-DECISION" log entry per request at
// the Info level (or Warn on deny). The hook maps this to our EgressEvent shape.
//
// Fields read from the logrus entry (see smokescreen.go LogField* constants):
//   - "inbound_remote_addr"  → SrcIp
//   - "requested_host"       → Target
//   - "allow"                → Action (bool → "allowed"/"blocked")
//   - "decision_reason"      → Reason
//   - "role"                 → StackId
//   - "proxy_type"           → Protocol ("http" vs "connect")
//   - "content_length"       → BytesDown (approximate for HTTP forward)
type NDJSONLogHook struct{}

// Levels returns the logrus levels that should trigger this hook.
// Info covers allowed decisions; Warn covers denied decisions.
func (h *NDJSONLogHook) Levels() []logrus.Level {
	return []logrus.Level{logrus.InfoLevel, logrus.WarnLevel, logrus.ErrorLevel}
}

// Fire is called by logrus for each matching log entry.
func (h *NDJSONLogHook) Fire(entry *logrus.Entry) error {
	if entry.Message != "CANONICAL-PROXY-DECISION" {
		return nil
	}

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

	// Byte counts — smokescreen logs content_length on HTTP forward proxy responses
	if v, ok := entry.Data["content_length"].(int64); ok && v > 0 {
		evt.BytesDown = v
	}

	emitEgressEvent(evt)
	return nil
}

// NewNDJSONLogHook constructs the hook.
func NewNDJSONLogHook() *NDJSONLogHook {
	return &NDJSONLogHook{}
}
