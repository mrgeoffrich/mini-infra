package proxy

import (
	"net"

	smokescreen "github.com/stripe/smokescreen/pkg/smokescreen"
)

// BuiltinPrivateRanges returns the set of IP ranges that the egress gateway
// must always deny, regardless of stack rules.
//
// Covered ranges:
//   - RFC1918 private unicast:  10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
//   - Loopback:                 127.0.0.0/8
//   - Link-local (incl. IMDS): 169.254.0.0/16  (covers 169.254.169.254)
//   - IPv6 ULA:                 fc00::/7
//   - IPv6 link-local:          fe80::/10
//   - IPv4 multicast:           224.0.0.0/4
//   - IPv6 multicast:           ff00::/8
//
// These are passed as smokescreen.Config.DenyRanges to provide SSRF defence
// at the IP-classification layer (before DNS resolution).
func BuiltinPrivateRanges() []smokescreen.RuleRange {
	cidrs := []string{
		// RFC1918
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		// Loopback
		"127.0.0.0/8",
		// Link-local — covers AWS/Azure metadata 169.254.169.254
		"169.254.0.0/16",
		// IPv6 ULA (fc00::/7 covers fc00:: through fdff::)
		"fc00::/7",
		// IPv6 link-local
		"fe80::/10",
		// Multicast
		"224.0.0.0/4",
		"ff00::/8",
	}

	ranges := make([]smokescreen.RuleRange, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			// All CIDRs above are constants — panic on misconfiguration rather
			// than silently weakening the SSRF defence.
			panic("egress-gateway: invalid built-in private CIDR " + cidr + ": " + err.Error())
		}
		ranges = append(ranges, smokescreen.RuleRange{Net: *ipNet})
	}
	return ranges
}
