package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"sync"
	"testing"

	"github.com/sirupsen/logrus"
)

// captureStdout temporarily replaces os.Stdout and returns the bytes written.
func captureStdout(fn func()) []byte {
	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w

	var wg sync.WaitGroup
	var buf bytes.Buffer
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(&buf, r)
	}()

	fn()

	os.Stdout = old
	_ = w.Close()
	wg.Wait()
	_ = r.Close()
	return buf.Bytes()
}

// parseNDJSON returns the first newline-delimited JSON object from b.
func parseNDJSON(t *testing.T, b []byte) EgressEvent {
	t.Helper()
	lines := bytes.Split(bytes.TrimSpace(b), []byte("\n"))
	if len(lines) == 0 || len(lines[0]) == 0 {
		t.Fatal("no NDJSON output captured")
	}
	var evt EgressEvent
	if err := json.Unmarshal(lines[0], &evt); err != nil {
		t.Fatalf("failed to parse NDJSON output: %v\nraw: %s", err, lines[0])
	}
	return evt
}

func makeEntry(msg string, fields logrus.Fields) *logrus.Entry {
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	entry := logrus.NewEntry(logger)
	entry.Message = msg
	entry.Data = fields
	return entry
}

// ---------------------------------------------------------------------------
// CANONICAL-PROXY-DECISION tests
// ---------------------------------------------------------------------------

func TestNDJSONLogHook_Decision_AllowedHTTP(t *testing.T) {
	hook := NewNDJSONLogHook()
	entry := makeEntry("CANONICAL-PROXY-DECISION", logrus.Fields{
		"proxy_type":          "http",
		"inbound_remote_addr": "10.1.2.3:5000",
		"requested_host":      "api.example.com",
		"allow":               true,
		"decision_reason":     "rule-allow",
		"role":                "stk_abc",
		"content_length":      int64(1024),
	})

	out := captureStdout(func() {
		_ = hook.Fire(entry)
	})

	evt := parseNDJSON(t, out)
	if evt.Evt != "tcp" {
		t.Errorf("evt: want 'tcp', got %q", evt.Evt)
	}
	if evt.Protocol != "http" {
		t.Errorf("protocol: want 'http', got %q", evt.Protocol)
	}
	if evt.SrcIp != "10.1.2.3:5000" {
		t.Errorf("srcIp: want '10.1.2.3:5000', got %q", evt.SrcIp)
	}
	if evt.Target != "api.example.com" {
		t.Errorf("target: want 'api.example.com', got %q", evt.Target)
	}
	if evt.Action != "allowed" {
		t.Errorf("action: want 'allowed', got %q", evt.Action)
	}
	if evt.BytesDown != 1024 {
		t.Errorf("bytesDown: want 1024, got %d", evt.BytesDown)
	}
	if evt.StackId == nil || *evt.StackId != "stk_abc" {
		t.Errorf("stackId: want 'stk_abc', got %v", evt.StackId)
	}
}

func TestNDJSONLogHook_Decision_BlockedConnect(t *testing.T) {
	hook := NewNDJSONLogHook()
	entry := makeEntry("CANONICAL-PROXY-DECISION", logrus.Fields{
		"proxy_type":          "connect",
		"inbound_remote_addr": "10.0.0.5:6000",
		"requested_host":      "badsite.com:443",
		"allow":               false,
		"decision_reason":     "rule-deny",
		"role":                "stk_xyz",
	})

	out := captureStdout(func() {
		_ = hook.Fire(entry)
	})

	evt := parseNDJSON(t, out)
	if evt.Protocol != "connect" {
		t.Errorf("protocol: want 'connect', got %q", evt.Protocol)
	}
	if evt.Action != "blocked" {
		t.Errorf("action: want 'blocked', got %q", evt.Action)
	}
	if evt.Reason != "rule-deny" {
		t.Errorf("reason: want 'rule-deny', got %q", evt.Reason)
	}
}

// ---------------------------------------------------------------------------
// CANONICAL-PROXY-CN-CLOSE tests
// ---------------------------------------------------------------------------

func TestNDJSONLogHook_ConnClose(t *testing.T) {
	bytesIn := uint64(4096)
	bytesOut := uint64(8192)

	hook := NewNDJSONLogHook()
	entry := makeEntry("CANONICAL-PROXY-CN-CLOSE", logrus.Fields{
		"inbound_remote_addr": "10.1.2.3:5000",
		"requested_host":      "secure.example.com:443",
		"role":                "stk_abc",
		"bytes_in":            &bytesIn,
		"bytes_out":           &bytesOut,
	})

	out := captureStdout(func() {
		_ = hook.Fire(entry)
	})

	evt := parseNDJSON(t, out)
	if evt.Protocol != "connect" {
		t.Errorf("protocol: want 'connect', got %q", evt.Protocol)
	}
	if evt.Action != "allowed" {
		t.Errorf("action: want 'allowed', got %q", evt.Action)
	}
	if evt.BytesUp != int64(bytesIn) {
		t.Errorf("bytesUp: want %d, got %d", bytesIn, evt.BytesUp)
	}
	if evt.BytesDown != int64(bytesOut) {
		t.Errorf("bytesDown: want %d, got %d", bytesOut, evt.BytesDown)
	}
}

// ---------------------------------------------------------------------------
// toInt64 type-conversion tests (Medium 2)
// ---------------------------------------------------------------------------

func TestToInt64_NumericTypes(t *testing.T) {
	cases := []struct {
		name  string
		input any
		want  int64
		ok    bool
	}{
		{"int64", int64(42), 42, true},
		{"int", int(99), 99, true},
		{"float64", float64(3.7), 3, true}, // truncated
		{"uint64", uint64(1000), 1000, true},
		{"*uint64", func() any { v := uint64(512); return &v }(), 512, true},
		{"*uint64 nil", (*uint64)(nil), 0, false},
		{"string", "hello", 0, false},
		{"nil", nil, 0, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := toInt64(tc.input)
			if ok != tc.ok {
				t.Errorf("ok: want %v, got %v", tc.ok, ok)
			}
			if ok && got != tc.want {
				t.Errorf("value: want %d, got %d", tc.want, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Non-canonical messages must not produce output
// ---------------------------------------------------------------------------

func TestNDJSONLogHook_IgnoresOtherMessages(t *testing.T) {
	hook := NewNDJSONLogHook()
	entry := makeEntry("some other log message", logrus.Fields{
		"proxy_type": "http",
	})

	out := captureStdout(func() {
		_ = hook.Fire(entry)
	})

	if len(bytes.TrimSpace(out)) != 0 {
		t.Errorf("expected no output for non-canonical message, got: %s", out)
	}
}
