package proxy

import (
	"encoding/json"
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

// UnknownIPDenyHandler wraps next with a pre-ACL check that fast-fails
// requests from source IPs not found in the container map with an HTTP 403
// and a JSON body. This runs before Smokescreen so unmapped IPs receive a
// deterministic deny response rather than relying on Smokescreen's error path
// (which may vary across versions and CONNECT vs HTTP proxy modes).
func UnknownIPDenyHandler(next http.Handler, containers *state.ContainerMap) http.Handler {
	type denyBody struct {
		Error string `json:"error"`
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		src := remoteIP(r)
		if containers.Lookup(src) == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			body, _ := json.Marshal(denyBody{
				Error: "egress denied: source IP " + src + " is not mapped to a managed stack",
			})
			_, _ = w.Write(body)
			return
		}
		next.ServeHTTP(w, r)
	})
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
