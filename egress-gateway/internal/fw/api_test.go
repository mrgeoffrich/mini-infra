package fw

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

func newTestServer(_ *testing.T) *Server {
	store := NewEnvStore()
	// Pre-populate a registered env for ipset tests.
	store.Set("test-env", EnvState{BridgeCIDR: "10.0.0.0/24", Mode: ModeObserve})
	return &Server{
		socketPath: "/tmp/test-fw.sock",
		store:      store,
		log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func postJSON(srv *Server, path string, body interface{}) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	buildMux(srv).ServeHTTP(rr, req)
	return rr
}

func deleteReq(srv *Server, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodDelete, path, nil)
	rr := httptest.NewRecorder()
	buildMux(srv).ServeHTTP(rr, req)
	return rr
}

func getReq(srv *Server, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rr := httptest.NewRecorder()
	buildMux(srv).ServeHTTP(rr, req)
	return rr
}

// buildMux mirrors the mux registration in Server.Run.
func buildMux(s *Server) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("POST /v1/env", s.handleApplyEnv)
	mux.HandleFunc("DELETE /v1/env/", s.handleRemoveEnv)
	mux.HandleFunc("POST /v1/ipset/", s.handleIpset)
	return mux
}

// mockIpsetCmd returns a no-op exec.Cmd that exits 0.
func mockIpsetCmd(_ string, _ ...string) *exec.Cmd {
	return exec.Command("true")
}

// ---------------------------------------------------------------------------
// validateEnvName tests
// ---------------------------------------------------------------------------

func TestValidateEnvName_Valid(t *testing.T) {
	cases := []string{
		"prod",
		"staging",
		"dev-1",
		"a",
		"abc123",
		"test-env",
	}
	for _, tc := range cases {
		t.Run(tc, func(t *testing.T) {
			if err := validateEnvName(tc); err != nil {
				t.Errorf("expected valid, got error: %v", err)
			}
		})
	}
}

func TestValidateEnvName_PathTraversal(t *testing.T) {
	cases := []string{
		"../etc/passwd",
		"..%2fetc%2fpasswd",
		"../../root",
		"foo/../bar",
		"/etc/passwd",
		"foo/bar",
		"%2e%2e",
	}
	for _, tc := range cases {
		t.Run(tc, func(t *testing.T) {
			if err := validateEnvName(tc); err == nil {
				t.Errorf("expected error for path traversal %q, got nil", tc)
			}
		})
	}
}

func TestValidateEnvName_ShellMetacharacters(t *testing.T) {
	cases := []string{
		"foo;rm -rf",
		"foo|bash",
		"foo$(date)",
		"foo`whoami`",
		"foo bar",
		"foo&bar",
	}
	for _, tc := range cases {
		t.Run(tc, func(t *testing.T) {
			if err := validateEnvName(tc); err == nil {
				t.Errorf("expected error for shell-meta %q, got nil", tc)
			}
		})
	}
}

func TestValidateEnvName_TabRejected(t *testing.T) {
	if err := validateEnvName("foo\tbar"); err == nil {
		t.Error("expected error for env name containing tab, got nil")
	}
}

func TestValidateEnvName_Oversized(t *testing.T) {
	long := strings.Repeat("a", 10000)
	if err := validateEnvName(long); err == nil {
		t.Error("expected error for 10KB env name, got nil")
	}
}

func TestValidateEnvName_UppercaseRejected(t *testing.T) {
	if err := validateEnvName("Prod"); err == nil {
		t.Error("expected error for uppercase env name, got nil")
	}
}

// ---------------------------------------------------------------------------
// validateBridgeCIDR tests
// ---------------------------------------------------------------------------

func TestValidateBridgeCIDR_Valid(t *testing.T) {
	cases := []string{
		"10.0.0.0/24",
		"172.16.0.0/12",
		"192.168.1.0/24",
		"10.100.0.0/16",
	}
	for _, tc := range cases {
		t.Run(tc, func(t *testing.T) {
			if _, _, err := validateBridgeCIDR(tc); err != nil {
				t.Errorf("expected valid, got error: %v", err)
			}
		})
	}
}

func TestValidateBridgeCIDR_OverlapLoopback(t *testing.T) {
	if _, _, err := validateBridgeCIDR("127.0.0.0/8"); err == nil {
		t.Error("expected error for loopback CIDR, got nil")
	}
	if _, _, err := validateBridgeCIDR("127.1.0.0/24"); err == nil {
		t.Error("expected error for CIDR inside loopback, got nil")
	}
}

func TestValidateBridgeCIDR_OverlapDefault(t *testing.T) {
	if _, _, err := validateBridgeCIDR("0.0.0.0/0"); err == nil {
		t.Error("expected error for 0.0.0.0/0, got nil")
	}
}

func TestValidateBridgeCIDR_IPv6Rejected(t *testing.T) {
	if _, _, err := validateBridgeCIDR("fd00::/8"); err == nil {
		t.Error("expected error for IPv6 CIDR, got nil")
	}
}

func TestValidateBridgeCIDR_Malformed(t *testing.T) {
	if _, _, err := validateBridgeCIDR("not-a-cidr"); err == nil {
		t.Error("expected error for malformed CIDR, got nil")
	}
}

// ---------------------------------------------------------------------------
// validateManagedIP tests
// ---------------------------------------------------------------------------

func TestValidateManagedIP_OutsideBridge(t *testing.T) {
	_, bridgeCIDR, _ := net.ParseCIDR("10.0.0.0/24")
	if err := validateManagedIP("1.2.3.4", bridgeCIDR); err == nil {
		t.Error("expected error for IP outside bridgeCidr, got nil")
	}
}

func TestValidateManagedIP_IPv6Rejected(t *testing.T) {
	_, bridgeCIDR, _ := net.ParseCIDR("10.0.0.0/24")
	if err := validateManagedIP("::1", bridgeCIDR); err == nil {
		t.Error("expected error for IPv6 ::1, got nil")
	}
	if err := validateManagedIP("2001:db8::1", bridgeCIDR); err == nil {
		t.Error("expected error for IPv6 2001:db8::1, got nil")
	}
}

func TestValidateManagedIP_Valid(t *testing.T) {
	_, bridgeCIDR, _ := net.ParseCIDR("10.0.0.0/24")
	if err := validateManagedIP("10.0.0.5", bridgeCIDR); err != nil {
		t.Errorf("expected valid, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// HTTP handler tests
// ---------------------------------------------------------------------------

func TestHandleHealth(t *testing.T) {
	srv := newTestServer(t)
	rr := getReq(srv, "/v1/health")
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestHandleApplyEnv_InvalidEnvName(t *testing.T) {
	srv := newTestServer(t)
	cases := []string{
		"../etc/passwd",
		"foo;bar",
		"foo|bar",
	}
	for _, env := range cases {
		t.Run(env, func(t *testing.T) {
			rr := postJSON(srv, "/v1/env", map[string]string{
				"env":        env,
				"bridgeCidr": "10.0.0.0/24",
				"mode":       "observe",
			})
			if rr.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d for env=%q", rr.Code, env)
			}
		})
	}
}

func TestHandleApplyEnv_InvalidBridgeCIDR(t *testing.T) {
	srv := newTestServer(t)
	cases := []struct {
		name string
		cidr string
	}{
		{"loopback", "127.0.0.0/8"},
		{"full-internet", "0.0.0.0/0"},
		{"malformed", "not-a-cidr"},
		{"ipv6", "fd00::/8"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := postJSON(srv, "/v1/env", map[string]string{
				"env":        "test",
				"bridgeCidr": tc.cidr,
				"mode":       "observe",
			})
			if rr.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d for cidr=%q", rr.Code, tc.cidr)
			}
		})
	}
}

func TestHandleApplyEnv_MalformedJSON(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/env", strings.NewReader("{not json}"))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	buildMux(srv).ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestHandleApplyEnv_MissingFields(t *testing.T) {
	srv := newTestServer(t)
	// Missing bridgeCidr and mode — these fields are required for validation.
	// Body has only "env" field; mode and bridgeCidr will be empty strings.
	rr := postJSON(srv, "/v1/env", map[string]string{"env": "myenv"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestHandleIpset_IPOutsideBridge(t *testing.T) {
	// Mock exec calls to avoid real system invocations.
	origIPSet := execIPSet
	origCmd := execCommand
	defer func() {
		execIPSet = origIPSet
		execCommand = origCmd
	}()
	execIPSet = func(name string, args ...string) *exec.Cmd { return exec.Command("true") }
	execCommand = func(name string, args ...string) *exec.Cmd { return exec.Command("true") }

	srv := newTestServer(t)
	// test-env has bridgeCIDR 10.0.0.0/24; 1.2.3.4 is outside.
	rr := postJSON(srv, "/v1/ipset/test-env/managed/add", map[string]string{"ip": "1.2.3.4"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d; body: %s", rr.Code, rr.Body.String())
	}
}

func TestHandleIpset_IPv6Rejected(t *testing.T) {
	srv := newTestServer(t)
	rr := postJSON(srv, "/v1/ipset/test-env/managed/add", map[string]string{"ip": "::1"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d; body: %s", rr.Code, rr.Body.String())
	}
}

func TestHandleIpset_UnregisteredEnv(t *testing.T) {
	srv := newTestServer(t)
	rr := postJSON(srv, "/v1/ipset/nonexistent/managed/add", map[string]string{"ip": "10.0.0.1"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for unregistered env, got %d", rr.Code)
	}
}

func TestHandleIpset_PathTraversalEnvName(t *testing.T) {
	srv := newTestServer(t)
	rr := postJSON(srv, "/v1/ipset/../etc/passwd/managed/add", map[string]string{"ip": "10.0.0.1"})
	if rr.Code == http.StatusOK {
		t.Errorf("expected non-200 for path traversal env, got %d", rr.Code)
	}
}

func TestHandleWrongMethod(t *testing.T) {
	srv := newTestServer(t)
	// GET on a DELETE-only path should get 405 or 404.
	req := httptest.NewRequest(http.MethodGet, "/v1/env/test-env", nil)
	rr := httptest.NewRecorder()
	buildMux(srv).ServeHTTP(rr, req)
	if rr.Code == http.StatusOK {
		t.Errorf("expected non-200, got %d", rr.Code)
	}
}
