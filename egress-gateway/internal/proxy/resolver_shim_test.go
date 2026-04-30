package proxy

import (
	"context"
	"crypto/tls"
	"errors"
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
	"github.com/stripe/smokescreen/pkg/smokescreen/conntrack"

	"github.com/mrgeoffrich/mini-infra/egress-shared/state"
)

// fakeResolver is a smokescreen.Resolver that always returns the configured
// errors from LookupIP / LookupPort. Used to deterministically inject the
// `context.Canceled` failure that triggered the original bug without having
// to race Go's parallel A/AAAA cancellation in real DNS.
type fakeResolver struct {
	lookupIPErr   error
	lookupPortErr error
	port          int
	ip            net.IP
}

func (f *fakeResolver) LookupPort(ctx context.Context, network, service string) (int, error) {
	if f.lookupPortErr != nil {
		return 0, f.lookupPortErr
	}
	if f.port != 0 {
		return f.port, nil
	}
	return 443, nil
}

func (f *fakeResolver) LookupIP(ctx context.Context, network, host string) ([]net.IP, error) {
	if f.lookupIPErr != nil {
		return nil, f.lookupIPErr
	}
	if f.ip == nil {
		return []net.IP{net.ParseIP("127.0.0.1")}, nil
	}
	return []net.IP{f.ip}, nil
}

// TestResolverShim_MapsContextCanceledToDNSError is the unit-level guard for
// the shim's whole reason for existing: a `context.Canceled` from the inner
// resolver must surface as a `*net.DNSError` flagged Timeout so smokescreen's
// rejectResponse maps it to 504 instead of the catch-all 500.
func TestResolverShim_MapsContextCanceledToDNSError(t *testing.T) {
	inner := &fakeResolver{lookupIPErr: context.Canceled}
	shim := NewResolverShim(inner)

	_, err := shim.LookupIP(context.Background(), "ip", "example.test")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	var dnsErr *net.DNSError
	if !errors.As(err, &dnsErr) {
		t.Fatalf("want *net.DNSError, got %T (%v)", err, err)
	}
	if !dnsErr.IsTimeout || !dnsErr.IsTemporary {
		t.Errorf("DNSError flags: want Timeout=true Temporary=true, got %+v", dnsErr)
	}

	// And it must satisfy net.Error.Timeout() so rejectResponse hits 504.
	var netErr net.Error
	if !errors.As(err, &netErr) {
		t.Fatalf("want net.Error, got %T", err)
	}
	if !netErr.Timeout() {
		t.Errorf("net.Error.Timeout(): want true, got false")
	}
}

// TestResolverShim_LeavesOtherErrorsAlone confirms the shim is targeted —
// it does not blanket-rewrite DNS errors that already classify cleanly
// (e.g. context.DeadlineExceeded, real *net.DNSError).
func TestResolverShim_LeavesOtherErrorsAlone(t *testing.T) {
	t.Run("DeadlineExceeded passes through", func(t *testing.T) {
		inner := &fakeResolver{lookupIPErr: context.DeadlineExceeded}
		shim := NewResolverShim(inner)
		_, err := shim.LookupIP(context.Background(), "ip", "example.test")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("want context.DeadlineExceeded, got %v", err)
		}
	})

	t.Run("real net.DNSError passes through", func(t *testing.T) {
		original := &net.DNSError{Err: "no such host", Name: "example.test"}
		inner := &fakeResolver{lookupIPErr: original}
		shim := NewResolverShim(inner)
		_, err := shim.LookupIP(context.Background(), "ip", "example.test")
		if err != original {
			t.Errorf("want original DNSError, got %v", err)
		}
	})

	t.Run("nil error passes through", func(t *testing.T) {
		inner := &fakeResolver{}
		shim := NewResolverShim(inner)
		ips, err := shim.LookupIP(context.Background(), "ip", "example.test")
		if err != nil {
			t.Errorf("want nil error, got %v", err)
		}
		if len(ips) == 0 {
			t.Errorf("want non-empty IPs, got empty")
		}
	})
}

// TestBuildGatewayHandler_ContextCanceledInResolver_ReturnsGatewayTimeout
// is the end-to-end regression. Without the shim, smokescreen's
// rejectResponse returns 500 for `context.Canceled` because the sentinel
// doesn't implement net.Error. With the shim, the error becomes a Timeout
// net.Error and the proxy returns 504 — and crucially, the canonical
// decision log no longer has the misleading shape "rule has allow and
// report policy" + status_code: 500 + error: context canceled.
func TestBuildGatewayHandler_ContextCanceledInResolver_ReturnsGatewayTimeout(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)

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

	// Build the handler the way production does, then swap in a smokescreen
	// config whose resolver always returns `context.Canceled` from LookupIP.
	// We replicate BuildGatewayHandler's wiring rather than calling it
	// directly so the fake resolver lands on the smokescreen.Config.
	_, loopbackNet, _ := net.ParseCIDR("127.0.0.0/8")
	sk := smokescreen.NewConfig()
	sk.RoleFromRequest = RoleFromRequest(containers)
	sk.EgressACL = aclSwapper
	sk.AllowRanges = []smokescreen.RuleRange{{Net: *loopbackNet}}
	sk.ConnectTimeout = 2 * time.Second
	sk.Log = logger
	sk.AllowMissingRole = false
	sk.Resolver = NewResolverShim(&fakeResolver{lookupIPErr: context.Canceled})
	sk.ShuttingDown.Store(false)
	sk.ConnTracker = conntrack.NewTracker(sk.IdleTimeout, sk.MetricsClient, sk.Log, sk.ShuttingDown, nil)
	handler := DoHGate(UnknownIPDenyHandler(smokescreen.BuildProxy(sk), containers))

	srv := &http.Server{
		Handler:           handler,
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

	// CONNECT failures are surfaced to the client as a transport error
	// rather than a real HTTP response. The important assertion is that the
	// error message reflects a timeout/gateway-timeout shape — without the
	// shim the gateway returns "500 Internal Server Error" and Go's
	// transport reports `Get "...": Internal Server Error`.
	if err != nil {
		if strings.Contains(err.Error(), "Internal") || strings.Contains(err.Error(), "500") {
			t.Fatalf("regression: got 500-shaped CONNECT failure — shim did not classify the cancel: %v", err)
		}
		// Any other CONNECT error (e.g. "Gateway timeout"/"Bad gateway") is acceptable.
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusInternalServerError {
		t.Fatalf("regression: got 500 from gateway after a context.Canceled DNS lookup — shim did not catch it")
	}
	if resp.StatusCode != http.StatusGatewayTimeout && resp.StatusCode != http.StatusBadGateway {
		t.Errorf("want 504 or 502 after a cancelled DNS lookup, got %d", resp.StatusCode)
	}
}
