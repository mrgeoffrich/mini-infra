package proxy

import (
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
	smokescreen "github.com/stripe/smokescreen/pkg/smokescreen"
	acl "github.com/stripe/smokescreen/pkg/smokescreen/acl/v1"

	"github.com/mrgeoffrich/mini-infra/egress-shared/state"
)

// TestBuildGatewayHandler_ConnectDoesNotPanic is the regression test for the
// nil-pointer panic in smokescreen.dialContext that fired on every CONNECT
// because BuildProxy never initialises ConnTracker. Before the fix this test
// panicked on the first CONNECT; after the fix the tunnel completes and the
// upstream HTTPS request returns 200.
func TestBuildGatewayHandler_ConnectDoesNotPanic(t *testing.T) {
	// Real HTTPS upstream the proxy will tunnel us to.
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "hello")
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	// Listener for the gateway proxy.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	// Map the loopback client IP to a stack so RoleFromRequest succeeds.
	containers := state.NewContainerMap()
	containers.Replace(map[string]*state.ContainerAttr{
		"127.0.0.1": {StackID: "stk_test", ServiceName: "web"},
	})
	aclSwapper := NewACLSwapper() // permissive default — Report policy on every host

	logger := logrus.New()
	logger.SetOutput(io.Discard)

	// DenyRanges is empty and AllowRanges explicitly allows loopback so the
	// proxy can dial the httptest upstream — the regression we're guarding
	// against fires on the happy path through dialContext, which only runs
	// once IP classification allows the connection.
	_, loopbackNet, _ := net.ParseCIDR("127.0.0.0/8")
	srv := &http.Server{
		Handler: BuildGatewayHandler(containers, aclSwapper, logger, GatewayOptions{
			AllowRanges: []smokescreen.RuleRange{{Net: *loopbackNet}},
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	// Client that goes via the proxy. Skip TLS verify on the upstream test cert.
	proxyURL := &url.URL{Scheme: "http", Host: ln.Addr().String()}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}

	// Smokescreen ACLs match on hostname, so connect via "localhost" (the cert
	// is for 127.0.0.1, hence InsecureSkipVerify).
	target := "https://localhost:" + upstreamURL.Port()
	resp, err := client.Get(target)
	if err != nil {
		t.Fatalf("CONNECT through gateway failed (was the panic reintroduced?): %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("want 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "hello") {
		t.Errorf("unexpected body: %q", body)
	}
}

// TestBuildGatewayHandler_ReportModeClientCancelMidDial guards the gateway's
// recovery path: when a client gives up mid-dial against a slow upstream,
// the next request through the same handler must still complete cleanly.
// This is the resilience side of the report-mode 500 bug — the deterministic
// reproduction of the actual symptom lives in
// resolver_shim_test.go's TestBuildGatewayHandler_ContextCanceledInResolver.
func TestBuildGatewayHandler_ReportModeClientCancelMidDial(t *testing.T) {
	// Slow upstream — accepts CONNECT but stalls the TLS handshake so the
	// proxy is still in the middle of dialing/handshaking when the client
	// gives up.
	slow := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "late")
	}))
	slow.EnableHTTP2 = false
	slow.StartTLS()
	defer slow.Close()

	slowURL, err := url.Parse(slow.URL)
	if err != nil {
		t.Fatalf("parse slow url: %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	containers := state.NewContainerMap()
	containers.Replace(map[string]*state.ContainerAttr{
		"127.0.0.1": {StackID: "stk_test", ServiceName: "web"},
	})

	aclSwapper := NewACLSwapper()
	aclSwapper.Swap(&acl.ACL{
		Rules: map[string]acl.Rule{
			"stk_test": {
				Project:     "stk_test",
				Policy:      acl.Report,
				DomainGlobs: []string{"allowed.example.com"},
			},
		},
		DefaultRule: &acl.Rule{Policy: acl.Report},
	})

	logger := logrus.New()
	logger.SetOutput(io.Discard)

	_, loopbackNet, _ := net.ParseCIDR("127.0.0.0/8")
	srv := &http.Server{
		Handler: BuildGatewayHandler(containers, aclSwapper, logger, GatewayOptions{
			AllowRanges: []smokescreen.RuleRange{{Net: *loopbackNet}},
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	proxyURL := &url.URL{Scheme: "http", Host: ln.Addr().String()}

	// First request: client gives up after 250ms while upstream is still
	// "handshaking" (sleeping 2s).
	clientShort := &http.Client{
		Timeout: 250 * time.Millisecond,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
	target := "https://localhost:" + slowURL.Port()
	if _, err := clientShort.Get(target); err == nil {
		t.Logf("first request unexpectedly succeeded (slow upstream may have raced)")
	}

	// Second request: full timeout — must still go through cleanly.
	clientLong := &http.Client{
		Timeout: 8 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
	resp, err := clientLong.Get(target)
	if err != nil {
		t.Fatalf("second request through gateway after a cancelled first: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("second request: want 200, got %d", resp.StatusCode)
	}
}

// TestBuildGatewayHandler_ReportModeWouldDeny is a regression test for the
// "report mode + would-deny" path returning HTTP 500 with `error: "context
// canceled"`. In Report mode the rule's DomainGlobs drives the
// `enforce_would_deny` log signal: any host outside that allow list trips
// would-deny but should still tunnel cleanly. The original bug surfaced as
// `wget --timeout=8 https://api.anthropic.com` returning 500 with
// `decision_reason: "rule has allow and report policy", enforce_would_deny:
// true, error: "context canceled"` — the gateway was failing requests it
// was supposed to allow-and-log.
//
// Repro shape: a stack with an explicit allow glob ("allowed.example.com")
// trying to reach a host outside that glob ("localhost"). Both before and
// after the fix this hits the AllowAndReport branch in
// smokescreen.checkACLsForRequest; expectation is HTTP 200 with the upstream
// body.
func TestBuildGatewayHandler_ReportModeWouldDeny(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "hello")
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream url: %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	containers := state.NewContainerMap()
	containers.Replace(map[string]*state.ContainerAttr{
		"127.0.0.1": {StackID: "stk_test", ServiceName: "web"},
	})

	// Push an ACL with a single Report-mode rule whose DomainGlobs allow
	// only "allowed.example.com" — the upstream we're tunneling to is
	// "localhost", so the request hits AllowAndReport (would-deny but
	// permitted because the rule is in Report mode).
	aclSwapper := NewACLSwapper()
	aclSwapper.Swap(&acl.ACL{
		Rules: map[string]acl.Rule{
			"stk_test": {
				Project:     "stk_test",
				Policy:      acl.Report,
				DomainGlobs: []string{"allowed.example.com"},
			},
		},
		DefaultRule: &acl.Rule{Policy: acl.Report},
	})

	logger := logrus.New()
	logger.SetOutput(io.Discard)

	_, loopbackNet, _ := net.ParseCIDR("127.0.0.0/8")
	srv := &http.Server{
		Handler: BuildGatewayHandler(containers, aclSwapper, logger, GatewayOptions{
			AllowRanges: []smokescreen.RuleRange{{Net: *loopbackNet}},
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	proxyURL := &url.URL{Scheme: "http", Host: ln.Addr().String()}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(proxyURL),
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}

	target := "https://localhost:" + upstreamURL.Port()
	resp, err := client.Get(target)
	if err != nil {
		t.Fatalf("CONNECT through gateway in report-mode failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("want 200 (report mode should allow + log), got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "hello") {
		t.Errorf("unexpected body: %q", body)
	}
}
