package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/state"
)

// TestUnknownIPDenyHandler_FastFail verifies that a request from an IP not in
// the container map receives a deterministic HTTP 403 JSON response well within
// a 1-second deadline — never a silent hang.
func TestUnknownIPDenyHandler_FastFail(t *testing.T) {
	containers := state.NewContainerMap() // empty — no mapped IPs

	innerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		innerCalled = true
		w.WriteHeader(http.StatusOK)
	})

	handler := UnknownIPDenyHandler(inner, containers)

	req := httptest.NewRequest(http.MethodConnect, "https://example.com:443", nil)
	req.RemoteAddr = "10.1.2.3:54321" // not in the container map

	done := make(chan struct{})
	var code int
	var bodyMap map[string]string

	go func() {
		defer close(done)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		code = w.Code
		_ = json.Unmarshal(w.Body.Bytes(), &bodyMap)
	}()

	select {
	case <-done:
		// completed synchronously — good
	case <-time.After(1 * time.Second):
		t.Fatal("handler did not respond within 1s — possible hang for unknown IP")
	}

	if code != http.StatusForbidden {
		t.Errorf("want HTTP 403, got %d", code)
	}
	if bodyMap["error"] == "" {
		t.Error("expected non-empty 'error' field in JSON body")
	}
	if innerCalled {
		t.Error("inner handler must not be called for unknown source IPs")
	}
}

// TestUnknownIPDenyHandler_MappedIPPasses verifies that a mapped IP is forwarded
// to the inner handler without modification.
func TestUnknownIPDenyHandler_MappedIPPasses(t *testing.T) {
	containers := state.NewContainerMap()
	containers.Replace(map[string]*state.ContainerAttr{
		"10.1.2.3": {StackID: "stk_abc", ServiceName: "web"},
	})

	innerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		innerCalled = true
		w.WriteHeader(http.StatusOK)
	})

	handler := UnknownIPDenyHandler(inner, containers)

	req := httptest.NewRequest(http.MethodConnect, "https://example.com:443", nil)
	req.RemoteAddr = "10.1.2.3:54321"

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if !innerCalled {
		t.Error("inner handler should be called for a mapped source IP")
	}
	if w.Code == http.StatusForbidden {
		t.Errorf("mapped IP should not get 403, got %d", w.Code)
	}
}
