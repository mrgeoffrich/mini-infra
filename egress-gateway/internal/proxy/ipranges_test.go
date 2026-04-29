package proxy

import (
	"net"
	"testing"
)

func TestBuiltinPrivateRanges_NotEmpty(t *testing.T) {
	ranges := BuiltinPrivateRanges()
	if len(ranges) == 0 {
		t.Fatal("expected non-empty private ranges")
	}
}

func TestBuiltinPrivateRanges_RFC1918(t *testing.T) {
	// Addresses that must be covered.
	mustBlock := []string{
		// 10.0.0.0/8
		"10.0.0.1",
		"10.100.200.50",
		"10.255.255.255",
		// 172.16.0.0/12
		"172.16.0.1",
		"172.31.255.255",
		// 192.168.0.0/16
		"192.168.1.1",
		"192.168.100.200",
		// Loopback
		"127.0.0.1",
		"127.255.255.255",
		// Link-local (incl. IMDS)
		"169.254.169.254",
		"169.254.0.1",
		// IPv6 ULA
		"fc00::1",
		"fdff::1",
		// IPv6 link-local
		"fe80::1",
		// Multicast
		"224.0.0.1",
		"239.255.255.255",
		"ff00::1",
	}

	for _, addr := range mustBlock {
		ip := net.ParseIP(addr)
		if ip == nil {
			t.Fatalf("invalid test IP: %s", addr)
		}
		if !isInPrivateRanges(ip) {
			t.Errorf("IP %s should be in private ranges but is not", addr)
		}
	}
}

func TestBuiltinPrivateRanges_PublicPassthrough(t *testing.T) {
	// Addresses that should NOT be blocked by the private ranges.
	mustAllow := []string{
		"8.8.8.8",
		"1.2.3.4",
		"203.0.113.1",
		"2001:db8::1",
	}

	for _, addr := range mustAllow {
		ip := net.ParseIP(addr)
		if ip == nil {
			t.Fatalf("invalid test IP: %s", addr)
		}
		if isInPrivateRanges(ip) {
			t.Errorf("public IP %s should NOT be in private ranges but is", addr)
		}
	}
}

// isInPrivateRanges is a test helper that checks whether ip is covered by
// BuiltinPrivateRanges.
func isInPrivateRanges(ip net.IP) bool {
	for _, r := range BuiltinPrivateRanges() {
		n := r.Net
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
