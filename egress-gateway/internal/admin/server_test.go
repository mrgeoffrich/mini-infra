package admin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sirupsen/logrus"

	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/proxy"
	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/state"
)

func makeServer() *Server {
	logger := logrus.New()
	logger.SetLevel(logrus.DebugLevel)
	return New(
		proxy.NewACLSwapper(),
		state.NewContainerMap(),
		state.NewRulesState(),
		logger,
	)
}

// ----- /admin/rules ---------------------------------------------------------

func TestHandleRules_ValidSnapshot(t *testing.T) {
	srv := makeServer()

	payload := `{
		"version": 7,
		"stackPolicies": {
			"stack-aaa": {
				"mode": "detect",
				"defaultAction": "allow",
				"rules": [
					{"id":"r1","pattern":"*.example.com","action":"allow","targets":[]}
				]
			}
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/admin/rules", bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp RulesSnapshotResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Version != 7 {
		t.Errorf("version: want 7, got %d", resp.Version)
	}
	if !resp.Accepted {
		t.Error("expected accepted=true")
	}
	if resp.StackCount != 1 {
		t.Errorf("stackCount: want 1, got %d", resp.StackCount)
	}
	if resp.RuleCount != 1 {
		t.Errorf("ruleCount: want 1, got %d", resp.RuleCount)
	}

	// Verify rules state was updated.
	if srv.rulesState.Version() != 7 {
		t.Errorf("rulesState version: want 7, got %d", srv.rulesState.Version())
	}
}

func TestHandleRules_InvalidJSON(t *testing.T) {
	srv := makeServer()

	req := httptest.NewRequest(http.MethodPost, "/admin/rules", bytes.NewBufferString("not json"))
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", w.Code)
	}
}

// ----- /admin/container-map -------------------------------------------------

func TestHandleContainerMap_ValidPayload(t *testing.T) {
	srv := makeServer()

	payload := `{
		"version": 3,
		"entries": [
			{"ip":"10.0.0.2","stackId":"stack-111","serviceName":"web","containerId":"c1"},
			{"ip":"10.0.0.3","stackId":"stack-111","serviceName":"db","containerId":"c2"}
		]
	}`

	req := httptest.NewRequest(http.MethodPost, "/admin/container-map", bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp ContainerMapResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.EntryCount != 2 {
		t.Errorf("entryCount: want 2, got %d", resp.EntryCount)
	}
	if !resp.Accepted {
		t.Error("expected accepted=true")
	}

	// Verify container map was updated.
	attr := srv.containers.Lookup("10.0.0.2")
	if attr == nil {
		t.Fatal("expected entry for 10.0.0.2")
	}
	if attr.StackID != "stack-111" {
		t.Errorf("stackId: want stack-111, got %q", attr.StackID)
	}
	if attr.ServiceName != "web" {
		t.Errorf("serviceName: want web, got %q", attr.ServiceName)
	}

	// Unknown IP returns nil.
	if srv.containers.Lookup("99.99.99.99") != nil {
		t.Error("unknown IP should return nil")
	}
}

func TestHandleContainerMap_InvalidJSON(t *testing.T) {
	srv := makeServer()

	req := httptest.NewRequest(http.MethodPost, "/admin/container-map", bytes.NewBufferString("{bad"))
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", w.Code)
	}
}

// ----- /admin/health --------------------------------------------------------

func TestHandleHealth(t *testing.T) {
	srv := makeServer()
	srv.SetProxyUp(true)
	srv.SetAdminUp(true)

	req := httptest.NewRequest(http.MethodGet, "/admin/health", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}

	var resp HealthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.OK {
		t.Error("expected ok=true")
	}
	if !resp.Listeners.Proxy {
		t.Error("expected listeners.proxy=true")
	}
	if !resp.Listeners.Admin {
		t.Error("expected listeners.admin=true")
	}
}

// ----- Integration: rules then container-map lookups -----------------------

func TestRoundTrip_RulesThenContainerMap(t *testing.T) {
	srv := makeServer()

	// Push rules.
	rulesPayload := `{
		"version": 1,
		"stackPolicies": {
			"s1": {
				"mode": "enforce",
				"defaultAction": "block",
				"rules": [
					{"id":"r1","pattern":"*.allowed.io","action":"allow","targets":[]}
				]
			}
		}
	}`
	rulesReq := httptest.NewRequest(http.MethodPost, "/admin/rules", bytes.NewBufferString(rulesPayload))
	rulesW := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rulesW, rulesReq)
	if rulesW.Code != http.StatusOK {
		t.Fatalf("rules push failed: %d", rulesW.Code)
	}

	// Push container map.
	mapPayload := `{
		"version": 1,
		"entries": [{"ip":"172.20.0.5","stackId":"s1","serviceName":"app"}]
	}`
	mapReq := httptest.NewRequest(http.MethodPost, "/admin/container-map", bytes.NewBufferString(mapPayload))
	mapW := httptest.NewRecorder()
	srv.Handler().ServeHTTP(mapW, mapReq)
	if mapW.Code != http.StatusOK {
		t.Fatalf("container map push failed: %d", mapW.Code)
	}

	// ACL swapper should now hold the compiled ACL.
	a := srv.aclSwapper.Current()
	if a == nil {
		t.Fatal("expected non-nil ACL after rules push")
	}
	rule, ok := a.Rules["s1"]
	if !ok {
		t.Fatal("expected rule for s1")
	}
	if len(rule.DomainGlobs) != 1 || rule.DomainGlobs[0] != "*.allowed.io" {
		t.Errorf("unexpected domain globs: %v", rule.DomainGlobs)
	}

	// Container map lookup.
	attr := srv.containers.Lookup("172.20.0.5")
	if attr == nil || attr.StackID != "s1" {
		t.Errorf("container map lookup failed: %+v", attr)
	}
}
