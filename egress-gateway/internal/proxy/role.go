package proxy

import (
	"net"
	"net/http"

	smokescreen "github.com/stripe/smokescreen/pkg/smokescreen"

	"github.com/mrgeoffrich/mini-infra/egress-gateway/internal/state"
)

// RoleFromRequest returns the Smokescreen role (== stackId) for the connection.
// The role is resolved by looking up the client's source IP in the container map.
// If the source IP is not in the map, MissingRoleError is returned so Smokescreen
// can apply its AllowMissingRole policy (by default: deny).
func RoleFromRequest(containers *state.ContainerMap) func(*http.Request) (string, error) {
	return func(r *http.Request) (string, error) {
		src := remoteIP(r)
		attr := containers.Lookup(src)
		if attr == nil {
			// smokescreen.MissingRoleError is the sentinel the proxy uses to
			// distinguish "I don't know who this is" from "lookup failed".
			return "", smokescreen.MissingRoleError("unknown source IP: " + src)
		}
		return attr.StackID, nil
	}
}

// remoteIP extracts just the IP portion from r.RemoteAddr ("ip:port").
// If parsing fails the raw string is returned unchanged.
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
