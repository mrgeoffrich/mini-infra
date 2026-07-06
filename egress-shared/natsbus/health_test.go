package natsbus

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nats-io/nats.go"
)

// The /healthz wire shape is a cross-language contract with the TS scraper
// (`server/src/services/egress/agent-health-scraper.ts`) and the shared type
// `EgressAgentHealthReport`. These tests pin the JSON keys and the auth-failed
// value so a drift here fails locally before it reaches the server.

func TestHealthHandler_ReportsAuthFailed(t *testing.T) {
	status := nats.DISCONNECTED
	b := newTestBus(&status)
	b.authFailed.Store(true)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	HealthHandler(b, func() int64 { return 4321 })(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{`"status":"auth-failed"`, `"lastHeartbeatAgeMs":4321`} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in %s", want, body)
		}
	}

	var rep HealthReport
	if err := json.Unmarshal([]byte(body), &rep); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if rep.Status != ConnStateAuthFailed {
		t.Errorf("Status: want %q, got %q", ConnStateAuthFailed, rep.Status)
	}
}

func TestBuildHealthReport_NilInputs(t *testing.T) {
	rep := BuildHealthReport(nil, nil)
	if rep.Status != ConnStateDisconnected {
		t.Errorf("nil bus: want %q, got %q", ConnStateDisconnected, rep.Status)
	}
	if rep.LastHeartbeatAgeMs != -1 {
		t.Errorf("nil age accessor: want -1, got %d", rep.LastHeartbeatAgeMs)
	}
}
