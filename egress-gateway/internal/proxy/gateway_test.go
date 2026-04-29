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
