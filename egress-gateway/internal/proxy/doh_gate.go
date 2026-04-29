package proxy

import (
	"net/http"
	"strings"
)

// dohHosts is the denylist of known DNS-over-HTTPS (DoH) endpoints.
// Checked case-insensitively against the CONNECT target host or HTTP Host header.
// This gate runs before the Smokescreen ACL — it cannot be overridden by stack rules.
var dohHosts = []string{
	"dns.google",
	"dns.google.com",
	"cloudflare-dns.com",
	"1.1.1.1",
	"1.0.0.1",
	"quad9.net",
	"dns.quad9.net",
	"9.9.9.9",
	"dns.adguard-dns.com",
	"doh.opendns.com",
}

// DoHGate wraps next with a pre-ACL middleware that 403s known DoH endpoints.
// It matches both HTTP forward proxy requests (Host header / absolute-URI) and
// HTTPS CONNECT requests (target from the request line).
func DoHGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := connectTarget(r)
		if isDohHost(target) {
			http.Error(w, "403 Forbidden: DoH endpoint blocked by egress policy", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// connectTarget extracts the target hostname from both CONNECT and regular HTTP requests.
func connectTarget(r *http.Request) string {
	if r.Method == http.MethodConnect {
		// CONNECT target is "host:port" in the request URL
		host := r.URL.Host
		if host == "" {
			host = r.Host
		}
		// Strip port — we only care about hostname for the denylist.
		if idx := strings.LastIndex(host, ":"); idx >= 0 {
			host = host[:idx]
		}
		return host
	}
	// HTTP forward proxy: Host header (may include port)
	host := r.Host
	if idx := strings.LastIndex(host, ":"); idx >= 0 {
		host = host[:idx]
	}
	return host
}

// isDohHost returns true if host (case-insensitive) matches any doh denylist entry.
func isDohHost(host string) bool {
	lc := strings.ToLower(strings.TrimSpace(host))
	for _, blocked := range dohHosts {
		if lc == blocked {
			return true
		}
	}
	return false
}
