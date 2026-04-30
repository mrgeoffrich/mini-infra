package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/sirupsen/logrus"

	"github.com/mrgeoffrich/mini-infra/auth-proxy/internal/accesslog"
)

// fakeProvider is a stub Provider for tests.
type fakeProvider struct {
	name    string
	headers http.Header
	err     error
}

func (f *fakeProvider) Apply(_ context.Context) (http.Header, error) {
	return f.headers.Clone(), f.err
}
func (f *fakeProvider) Name() string { return f.name }

// newTestServer wires a Server in front of the supplied upstream, with a
// single provider+tenant called "anthropic/team-foo" that uses p.
func newTestServer(t *testing.T, upstream *httptest.Server, p Provider) *httptest.Server {
	t.Helper()
	u, _ := url.Parse(upstream.URL)
	srv := NewServer(map[string]Entry{
		"anthropic": {
			Upstream: u,
			Tenants:  map[string]Provider{"team-foo": p},
		},
	}, accesslog.NewLogger(io.Discard, logrus.ErrorLevel), logrus.New())
	srv.MarkReady()
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestServer_strips_inbound_auth_and_injects_provider_headers(t *testing.T) {
	var seenAuthKey, seenAuthHdr string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuthKey = r.Header.Get("X-Api-Key")
		seenAuthHdr = r.Header.Get("Authorization")
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	headers := http.Header{}
	headers.Set("x-api-key", "real-key")
	provider := &fakeProvider{name: "anthropic/team-foo", headers: headers}

	ts := newTestServer(t, upstream, provider)

	req, _ := http.NewRequest("GET", ts.URL+"/anthropic/team-foo/v1/messages", nil)
	req.Header.Set("X-Api-Key", "client-supplied-bogus")
	req.Header.Set("Authorization", "Bearer client-bogus")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Errorf("status: got %d", resp.StatusCode)
	}
	if seenAuthKey != "real-key" {
		t.Errorf("upstream x-api-key: got %q (client value should have been replaced)", seenAuthKey)
	}
	if seenAuthHdr != "" {
		t.Errorf("upstream Authorization: got %q (client value should have been stripped)", seenAuthHdr)
	}
}

func TestServer_strips_tenant_segment_from_upstream_path(t *testing.T) {
	var seenPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	provider := &fakeProvider{name: "p/t", headers: http.Header{}}
	ts := newTestServer(t, upstream, provider)

	resp, err := http.Get(ts.URL + "/anthropic/team-foo/v1/messages")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()

	if seenPath != "/v1/messages" {
		t.Errorf("upstream path: got %q, want /v1/messages", seenPath)
	}
}

func TestServer_preserves_query_string(t *testing.T) {
	var seenQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenQuery = r.URL.RawQuery
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	ts := newTestServer(t, upstream, &fakeProvider{name: "p/t", headers: http.Header{}})

	resp, err := http.Get(ts.URL + "/anthropic/team-foo/repos?per_page=3&page=2")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()

	if !strings.Contains(seenQuery, "per_page=3") || !strings.Contains(seenQuery, "page=2") {
		t.Errorf("query lost: got %q", seenQuery)
	}
}

func TestServer_preserves_post_body(t *testing.T) {
	var seenBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		seenBody = string(b)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	ts := newTestServer(t, upstream, &fakeProvider{name: "p/t", headers: http.Header{}})

	resp, err := http.Post(ts.URL+"/anthropic/team-foo/v1/messages", "application/json", strings.NewReader(`{"hello":"world"}`))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()

	if seenBody != `{"hello":"world"}` {
		t.Errorf("upstream body: got %q", seenBody)
	}
}

func TestServer_unknown_provider_returns_404(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream should not have been called")
	}))
	defer upstream.Close()

	ts := newTestServer(t, upstream, &fakeProvider{name: "p/t", headers: http.Header{}})

	resp, err := http.Get(ts.URL + "/nonsense/default/foo")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: got %d, want 404", resp.StatusCode)
	}
}

func TestServer_unknown_tenant_returns_404(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream should not have been called")
	}))
	defer upstream.Close()

	// Provider exists ("anthropic"), but no tenant "stranger" inside it.
	ts := newTestServer(t, upstream, &fakeProvider{name: "p/t", headers: http.Header{}})

	resp, err := http.Get(ts.URL + "/anthropic/stranger/v1/foo")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: got %d, want 404", resp.StatusCode)
	}
	if !strings.Contains(string(body), "stranger") {
		t.Errorf("body should name the missing tenant; got %q", string(body))
	}
}

func TestServer_bad_path_returns_400(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Errorf("upstream should not have been called")
	}))
	defer upstream.Close()

	ts := newTestServer(t, upstream, &fakeProvider{name: "p/t", headers: http.Header{}})

	for _, path := range []string{"/anthropic", "/anthropic/", "/"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatalf("request %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("path %s: status %d, want 400", path, resp.StatusCode)
		}
	}
}

func TestServer_provider_apply_failure_returns_502(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Errorf("upstream should not have been called when auth apply fails")
	}))
	defer upstream.Close()

	provider := &fakeProvider{
		name:    "anthropic/team-foo",
		headers: http.Header{},
		err:     errors.New("token endpoint returned 400: invalid_grant"),
	}
	ts := newTestServer(t, upstream, provider)

	resp, err := http.Get(ts.URL + "/anthropic/team-foo/v1/messages")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status: got %d, want 502", resp.StatusCode)
	}
	if !strings.Contains(string(body), "invalid_grant") {
		t.Errorf("body should propagate error detail; got %q", string(body))
	}
}

func TestServer_healthz_and_readyz(t *testing.T) {
	srv := NewServer(map[string]Entry{}, accesslog.NewLogger(io.Discard, logrus.ErrorLevel), logrus.New())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// healthz: always 200
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("healthz status: %d", resp.StatusCode)
	}

	// readyz: 503 before MarkReady
	resp, err = http.Get(ts.URL + "/readyz")
	if err != nil {
		t.Fatalf("readyz pre: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("readyz before mark: %d, want 503", resp.StatusCode)
	}

	// readyz: 200 after MarkReady
	srv.MarkReady()
	resp, err = http.Get(ts.URL + "/readyz")
	if err != nil {
		t.Fatalf("readyz post: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("readyz after mark: %d, want 200", resp.StatusCode)
	}
}
