// Package providers implements the credential strategies the proxy can apply
// to outbound requests. New strategies (e.g. service-account JWT) plug in by
// implementing the Provider interface.
package providers

import (
	"context"
	"net/http"
)

// Provider returns the headers to inject on every forwarded request for a
// given tenant. Apply may fail (e.g. OAuth refresh failure) — the proxy
// resolves headers up-front in the request handler so it can return a clean
// 502 instead of being swallowed inside ReverseProxy.Director.
type Provider interface {
	// Apply returns the headers to set on the upstream request. Headers
	// returned here REPLACE any value the inbound client supplied — the
	// proxy strips Authorization and X-Api-Key before merging.
	Apply(ctx context.Context) (http.Header, error)

	// Name is the provider/tenant identifier used in logs (e.g. "anthropic/team-foo").
	Name() string
}
