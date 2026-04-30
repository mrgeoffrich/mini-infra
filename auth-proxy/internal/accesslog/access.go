// Package accesslog emits one structured JSON line per proxied request.
//
// Hard rule: this package NEVER reads, copies, or logs request/response
// bodies, Authorization headers, X-Api-Key headers, or any field marked
// secret. The Entry struct is the entire surface area; if a field isn't on
// it, it can't be logged. Keep it that way.
package accesslog

import (
	"io"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// Entry is the structured shape of a single access-log record.
//
// Allowed: route metadata, status, byte counts, latency, error summary.
// Forbidden: Authorization, x-api-key, request bodies, response bodies,
// any field that could contain secrets minted by a Provider.
type Entry struct {
	Time      time.Time
	Method    string
	Path      string // inbound path, e.g. /anthropic/team-foo/v1/messages
	Upstream  string // resolved upstream URL — useful for debugging routing
	Provider  string // e.g. "anthropic"
	Tenant    string // e.g. "team-foo"
	Status    int
	BytesOut  int64
	LatencyMs int64
	Error     string // short error summary if the proxy returned a non-2xx itself
}

// Logger writes Entry records as JSON lines to a sink. It's a thin wrapper
// over logrus so we can later add fields, sampling, or sinks without
// disturbing call sites in proxy/server.go.
type Logger struct {
	mu  sync.Mutex
	log *logrus.Logger
}

// NewLogger builds a Logger that writes to w at the given level. Use
// logrus.InfoLevel in production; tests pass io.Discard + logrus.ErrorLevel
// to keep stdout clean.
func NewLogger(w io.Writer, level logrus.Level) *Logger {
	l := logrus.New()
	l.SetOutput(w)
	l.SetLevel(level)
	l.SetFormatter(&logrus.JSONFormatter{
		TimestampFormat: time.RFC3339,
		FieldMap: logrus.FieldMap{
			logrus.FieldKeyTime: "ts",
			logrus.FieldKeyMsg:  "msg",
		},
	})
	return &Logger{log: l}
}

// Log emits a single access-log entry.
func (l *Logger) Log(e Entry) {
	if l == nil || l.log == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	fields := logrus.Fields{
		"method":     e.Method,
		"path":       e.Path,
		"provider":   e.Provider,
		"tenant":     e.Tenant,
		"status":     e.Status,
		"bytes_out":  e.BytesOut,
		"latency_ms": e.LatencyMs,
	}
	if e.Upstream != "" {
		fields["upstream"] = e.Upstream
	}
	if e.Error != "" {
		fields["error"] = e.Error
	}
	if !e.Time.IsZero() {
		l.log.WithFields(fields).WithTime(e.Time).Info("proxied")
		return
	}
	l.log.WithFields(fields).Info("proxied")
}
