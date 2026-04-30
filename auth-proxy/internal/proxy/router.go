// Package proxy wires the path router, the reverse-proxy plumbing, and the
// HTTP server. The router is split out so it can be unit-tested without
// spinning up an httptest server.
package proxy

import (
	"errors"
	"regexp"
	"strings"
)

// ErrBadPath signals a malformed request path — the handler maps this to 400.
var ErrBadPath = errors.New("expected /<provider>/<tenant>/...")

// ErrInvalidTenant signals a tenant segment that doesn't match the
// permitted character set. Mapped to 400 by the handler.
var ErrInvalidTenant = errors.New("tenant must match [a-z0-9][a-z0-9-]*")

// Route is the parsed result of a request path: which provider/tenant the
// proxy should authenticate as, and what to forward upstream.
type Route struct {
	Provider string
	Tenant   string
	// Rest is the upstream path: always starts with "/", may be just "/".
	Rest string
}

var validTenant = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// ParsePath extracts (provider, tenant, rest) from a request path of the form
// /<provider>/<tenant>[/<rest>]. The provider lookup is the caller's job;
// here we only validate the shape and the tenant naming rule.
func ParsePath(path string) (Route, error) {
	parts := strings.SplitN(strings.TrimPrefix(path, "/"), "/", 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return Route{}, ErrBadPath
	}
	r := Route{Provider: parts[0], Tenant: parts[1], Rest: "/"}
	if len(parts) == 3 {
		r.Rest = "/" + parts[2]
	}
	if !validTenant.MatchString(r.Tenant) {
		return Route{}, ErrInvalidTenant
	}
	return r, nil
}
