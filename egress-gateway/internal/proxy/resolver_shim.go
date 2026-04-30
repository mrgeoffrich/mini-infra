package proxy

import (
	"context"
	"errors"
	"net"

	smokescreen "github.com/stripe/smokescreen/pkg/smokescreen"
)

// resolverShim wraps a smokescreen.Resolver and converts `context.Canceled`
// errors from upstream DNS lookups into `*net.DNSError` so smokescreen's
// rejectResponse classifies them as 504 Gateway Timeout rather than the
// catch-all 500 Internal Server Error.
//
// Why this matters: smokescreen calls our resolver with a context that has a
// finite timeout (default 5s). If the timeout fires, the resolver returns
// `context.DeadlineExceeded`, which already implements `net.Error.Timeout()
// == true` and rejectResponse maps it cleanly to 504. But if the lookup is
// cancelled for any other reason — e.g. Go's `net.Resolver.LookupIP` runs
// parallel A/AAAA queries and cancels the slower one — the resolver can
// return `context.Canceled`. That sentinel does NOT implement `net.Error`,
// so rejectResponse falls through to the generic "Internal server error"
// branch and the request 500s with `error: "context canceled"` in the log.
//
// On the wire that 500 is misleading: the rule was in Report mode, the
// decision was "allow and report", and the only thing that went wrong was a
// transient resolver hiccup. Mapping `context.Canceled` to a *net.DNSError
// (Timeout=true so it lands on 504) keeps the canonical-decision log
// honest and gives clients an actionable status code.
type resolverShim struct {
	inner smokescreen.Resolver
}

// NewResolverShim wraps inner with the context-cancel conversion described
// on resolverShim. Returns inner unchanged when nil so callers can pass
// `cfg.Resolver` straight through.
func NewResolverShim(inner smokescreen.Resolver) smokescreen.Resolver {
	if inner == nil {
		return nil
	}
	return &resolverShim{inner: inner}
}

func (r *resolverShim) LookupPort(ctx context.Context, network, service string) (int, error) {
	port, err := r.inner.LookupPort(ctx, network, service)
	return port, mapResolverCancel(err, service)
}

func (r *resolverShim) LookupIP(ctx context.Context, network, host string) ([]net.IP, error) {
	ips, err := r.inner.LookupIP(ctx, network, host)
	return ips, mapResolverCancel(err, host)
}

// mapResolverCancel returns err unchanged unless it wraps `context.Canceled`,
// in which case it returns a `*net.DNSError` flagged Timeout/Temporary so
// smokescreen's rejectResponse classifies it as 504 Gateway Timeout.
//
// `context.DeadlineExceeded` is left alone — it already implements
// `net.Error.Timeout()` and rejectResponse handles it correctly.
func mapResolverCancel(err error, name string) error {
	if err == nil || !errors.Is(err, context.Canceled) {
		return err
	}
	return &net.DNSError{
		Err:         "lookup cancelled: " + err.Error(),
		Name:        name,
		IsTemporary: true,
		IsTimeout:   true,
	}
}
