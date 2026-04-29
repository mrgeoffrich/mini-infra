package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDoHGate_BlocksKnownDoHHosts(t *testing.T) {
	blocked := []struct {
		method string
		host   string
		desc   string
	}{
		// Google DNS hostnames and IP literals
		{http.MethodConnect, "dns.google:443", "dns.google CONNECT"},
		{http.MethodConnect, "dns.google.com:443", "dns.google.com CONNECT"},
		{http.MethodConnect, "8.8.8.8:443", "8.8.8.8 IP literal CONNECT"},
		{http.MethodConnect, "8.8.4.4:443", "8.8.4.4 IP literal CONNECT"},
		// Cloudflare DNS
		{http.MethodConnect, "cloudflare-dns.com:443", "cloudflare-dns.com CONNECT"},
		{http.MethodConnect, "1.1.1.1:443", "1.1.1.1 CONNECT"},
		{http.MethodConnect, "1.0.0.1:443", "1.0.0.1 CONNECT"},
		// Quad9
		{http.MethodConnect, "quad9.net:443", "quad9.net CONNECT"},
		{http.MethodConnect, "dns.quad9.net:443", "dns.quad9.net CONNECT"},
		{http.MethodConnect, "9.9.9.9:443", "9.9.9.9 CONNECT"},
		{http.MethodConnect, "149.112.112.112:443", "149.112.112.112 Quad9 alternate CONNECT"},
		// Others
		{http.MethodConnect, "dns.adguard-dns.com:443", "dns.adguard-dns.com CONNECT"},
		{http.MethodConnect, "doh.opendns.com:443", "doh.opendns.com CONNECT"},
		// Case-insensitive
		{http.MethodConnect, "DNS.GOOGLE:443", "DNS.GOOGLE uppercase CONNECT"},
		// HTTP forward proxy
		{http.MethodGet, "", "dns.google HTTP GET"},
	}

	// Count handler calls to verify DoH requests never reach the inner handler.
	innerCalled := 0
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		innerCalled++
		w.WriteHeader(http.StatusOK)
	})
	handler := DoHGate(inner)

	for _, tc := range blocked {
		t.Run(tc.desc, func(t *testing.T) {
			var r *http.Request
			if tc.method == http.MethodConnect {
				r = httptest.NewRequest(http.MethodConnect, "https://"+tc.host, nil)
				r.Host = tc.host
			} else {
				r = httptest.NewRequest(http.MethodGet, "http://dns.google/resolve", nil)
				r.Host = "dns.google"
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != http.StatusForbidden {
				t.Errorf("want 403 for %q, got %d", tc.host, w.Code)
			}
		})
	}

	if innerCalled != 0 {
		t.Errorf("inner handler called %d times, want 0", innerCalled)
	}
}

func TestDoHGate_AllowsNonDoHHosts(t *testing.T) {
	allowed := []struct {
		host   string
		method string
	}{
		{"api.example.com", http.MethodConnect},
		{"example.org", http.MethodGet},
	}

	innerCalled := 0
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		innerCalled++
		w.WriteHeader(http.StatusOK)
	})
	handler := DoHGate(inner)

	for _, tc := range allowed {
		t.Run(tc.host, func(t *testing.T) {
			var r *http.Request
			if tc.method == http.MethodConnect {
				r = httptest.NewRequest(http.MethodConnect, "https://"+tc.host+":443", nil)
				r.Host = tc.host + ":443"
			} else {
				r = httptest.NewRequest(http.MethodGet, "http://"+tc.host+"/", nil)
				r.Host = tc.host
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code == http.StatusForbidden {
				t.Errorf("host %q should not be blocked", tc.host)
			}
		})
	}

	if innerCalled != len(allowed) {
		t.Errorf("inner handler called %d times, want %d", innerCalled, len(allowed))
	}
}
