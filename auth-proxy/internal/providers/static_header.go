package providers

import (
	"context"
	"net/http"
)

// StaticHeader injects a fixed set of headers on every request — the simplest
// strategy, used for API keys (Anthropic) and PATs (GitHub) that don't expire.
type StaticHeader struct {
	name    string
	headers http.Header
}

// NewStaticHeader builds a provider that sets the given headers on every
// request. The map is copied; later mutations don't leak in.
func NewStaticHeader(name string, headers map[string]string) *StaticHeader {
	h := http.Header{}
	for k, v := range headers {
		h.Set(k, v)
	}
	return &StaticHeader{name: name, headers: h}
}

// Apply returns a clone so callers can't mutate our internal state.
func (p *StaticHeader) Apply(_ context.Context) (http.Header, error) {
	return p.headers.Clone(), nil
}

// Name returns the provider/tenant identifier used in logs.
func (p *StaticHeader) Name() string { return p.name }
