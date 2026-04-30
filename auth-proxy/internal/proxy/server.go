package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/mrgeoffrich/mini-infra/auth-proxy/internal/accesslog"
)

// Provider is the subset of providers.Provider that the server needs.
// Defined locally to keep the proxy package import-light and to make the
// dependency easy to fake in tests.
type Provider interface {
	Apply(ctx context.Context) (http.Header, error)
	Name() string
}

// Entry binds a provider's upstream URL to its set of per-tenant Providers.
// The map mirrors the YAML config: the path segment after the provider name
// is the tenant key here.
type Entry struct {
	Upstream *url.URL
	Tenants  map[string]Provider
}

// Server holds the wiring for the auth-proxy HTTP server.
type Server struct {
	providers map[string]Entry
	access    *accesslog.Logger
	log       *logrus.Logger

	// ready flips to 1 once the server is wired up. /readyz returns 200 only
	// after this — gives orchestrators a signal to start sending traffic.
	ready atomic.Bool
}

// NewServer builds a Server from a {provider-name -> entry} map.
func NewServer(providers map[string]Entry, access *accesslog.Logger, log *logrus.Logger) *Server {
	if log == nil {
		log = logrus.StandardLogger()
	}
	return &Server{providers: providers, access: access, log: log}
}

// MarkReady should be called once startup is complete (config loaded,
// providers constructed, listener bound). /readyz returns 503 until then.
func (s *Server) MarkReady() { s.ready.Store(true) }

// Handler returns the http.Handler that serves /healthz, /readyz, and the
// proxy itself. Callers wrap it in their own http.Server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	mux.HandleFunc("/", s.handleProxy)
	return mux
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	if s.ready.Load() {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
		return
	}
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte("not ready"))
}

// statusRecorder wraps a ResponseWriter so the access log can record what
// upstream actually returned. We intentionally only track headers, status,
// and byte counts — never the body.
type statusRecorder struct {
	http.ResponseWriter
	status    int
	bytesOut  int64
	wroteHead bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.wroteHead {
		return
	}
	r.status = code
	r.wroteHead = true
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHead {
		r.status = http.StatusOK
		r.wroteHead = true
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytesOut += int64(n)
	return n, err
}

// Flush propagates flushes through to the wrapped writer so SSE / streaming
// responses don't get stuck behind our buffer.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	route, err := ParsePath(r.URL.Path)
	if err != nil {
		status := http.StatusBadRequest
		http.Error(w, err.Error(), status)
		s.access.Log(accesslog.Entry{
			Time: start, Method: r.Method, Path: r.URL.Path,
			Status: status, LatencyMs: latencyMs(start),
			Error: err.Error(),
		})
		return
	}

	entry, ok := s.providers[route.Provider]
	if !ok {
		status := http.StatusNotFound
		http.Error(w, "unknown provider: "+route.Provider, status)
		s.access.Log(accesslog.Entry{
			Time: start, Method: r.Method, Path: r.URL.Path,
			Provider: route.Provider, Tenant: route.Tenant,
			Status: status, LatencyMs: latencyMs(start),
			Error: "unknown provider",
		})
		return
	}

	provider, ok := entry.Tenants[route.Tenant]
	if !ok {
		status := http.StatusNotFound
		http.Error(w, "unknown tenant: "+route.Provider+"/"+route.Tenant, status)
		s.access.Log(accesslog.Entry{
			Time: start, Method: r.Method, Path: r.URL.Path,
			Provider: route.Provider, Tenant: route.Tenant,
			Status: status, LatencyMs: latencyMs(start),
			Error: "unknown tenant",
		})
		return
	}

	// Resolve auth headers up-front so OAuth refresh failures map cleanly
	// to 502 instead of being eaten inside ReverseProxy.Director.
	injected, err := provider.Apply(r.Context())
	if err != nil {
		status := http.StatusBadGateway
		http.Error(w, "auth provider error: "+err.Error(), status)
		s.access.Log(accesslog.Entry{
			Time: start, Method: r.Method, Path: r.URL.Path,
			Provider: route.Provider, Tenant: route.Tenant,
			Status: status, LatencyMs: latencyMs(start),
			Error: "auth apply: " + err.Error(),
		})
		return
	}

	rec := &statusRecorder{ResponseWriter: w}

	rp := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = entry.Upstream.Scheme
			req.URL.Host = entry.Upstream.Host
			req.Host = entry.Upstream.Host
			req.URL.Path = route.Rest
			req.URL.RawPath = ""

			// Defensively strip any inbound credential headers — clients
			// shouldn't send them, but if they do, we don't want them to
			// reach the upstream alongside the proxy's own.
			req.Header.Del("Authorization")
			req.Header.Del("X-Api-Key")

			// Inject the provider's headers.
			for k, vs := range injected {
				req.Header.Del(k)
				for _, v := range vs {
					req.Header.Add(k, v)
				}
			}
		},
		ErrorHandler: func(rw http.ResponseWriter, _ *http.Request, e error) {
			http.Error(rw, "upstream unreachable: "+e.Error(), http.StatusBadGateway)
		},
	}

	rp.ServeHTTP(rec, r)

	s.access.Log(accesslog.Entry{
		Time:      start,
		Method:    r.Method,
		Path:      r.URL.Path,
		Upstream:  entry.Upstream.String() + route.Rest,
		Provider:  route.Provider,
		Tenant:    route.Tenant,
		Status:    rec.status,
		BytesOut:  rec.bytesOut,
		LatencyMs: latencyMs(start),
	})
}

func latencyMs(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}

// EnsureValid returns nil if every entry has a valid upstream and at least
// one tenant. Cheap belt-and-braces — config validation already covers this
// but tests sometimes construct Server input by hand.
func EnsureValid(providers map[string]Entry) error {
	for name, e := range providers {
		if e.Upstream == nil || e.Upstream.Scheme == "" || e.Upstream.Host == "" {
			return errors.New("provider " + name + ": invalid upstream")
		}
		if len(e.Tenants) == 0 {
			return errors.New("provider " + name + ": no tenants")
		}
		for tname, p := range e.Tenants {
			if p == nil {
				return errors.New("provider " + name + " tenant " + tname + ": nil Provider")
			}
		}
	}
	return nil
}
