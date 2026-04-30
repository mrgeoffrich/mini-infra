package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// preExpiryWindow is the slack we keep before a cached access token expires —
// we refresh slightly early so requests don't race a 401 from the upstream.
const preExpiryWindow = 60 * time.Second

// fallbackTokenLifetime is used when an upstream returns no expires_in field.
// Most identity providers always send one, but be defensive.
const fallbackTokenLifetime = 3600 * time.Second

// OAuth2Refresh mints access tokens on demand from a long-lived refresh
// token, caches them in memory, and refreshes ahead of expiry. A
// single-flight gate ensures a burst of incoming requests collapses into one
// upstream token call.
type OAuth2Refresh struct {
	name         string
	tokenURL     string
	clientID     string
	clientSecret string
	refreshToken string
	httpClient   *http.Client

	mu         sync.Mutex
	accessTok  string
	expiresAt  time.Time
	refreshing chan struct{} // non-nil while a refresh is in flight; closed when it completes
	refreshErr error         // last refresh outcome — surfaced to waiters
}

// OAuth2Config bundles the constructor inputs.
type OAuth2Config struct {
	Name         string       // provider/tenant identifier for logs
	TokenURL     string       // e.g. https://oauth2.googleapis.com/token
	ClientID     string
	ClientSecret string
	RefreshToken string
	HTTPClient   *http.Client // defaults to http.DefaultClient
}

// NewOAuth2Refresh constructs a provider. It does NOT eagerly mint a token —
// the first request triggers the first refresh.
func NewOAuth2Refresh(cfg OAuth2Config) *OAuth2Refresh {
	hc := cfg.HTTPClient
	if hc == nil {
		hc = http.DefaultClient
	}
	return &OAuth2Refresh{
		name:         cfg.Name,
		tokenURL:     cfg.TokenURL,
		clientID:     cfg.ClientID,
		clientSecret: cfg.ClientSecret,
		refreshToken: cfg.RefreshToken,
		httpClient:   hc,
	}
}

// Name returns the provider/tenant identifier used in logs.
func (p *OAuth2Refresh) Name() string { return p.name }

// Apply returns Authorization: Bearer <access-token>, refreshing if needed.
func (p *OAuth2Refresh) Apply(ctx context.Context) (http.Header, error) {
	tok, err := p.getToken(ctx)
	if err != nil {
		return nil, err
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+tok)
	return h, nil
}

// getToken returns a valid access token, refreshing if the cached one is
// missing or about to expire. Concurrent callers either get the cached token
// or block on the in-flight refresh.
func (p *OAuth2Refresh) getToken(ctx context.Context) (string, error) {
	p.mu.Lock()
	if p.accessTok != "" && time.Until(p.expiresAt) > preExpiryWindow {
		tok := p.accessTok
		p.mu.Unlock()
		return tok, nil
	}
	if p.refreshing != nil {
		// A peer is already refreshing — wait for them and use the result.
		ch := p.refreshing
		p.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.refreshErr != nil {
			return "", p.refreshErr
		}
		return p.accessTok, nil
	}

	// We hold the mutex and there's no in-flight refresh — start one.
	p.refreshing = make(chan struct{})
	ch := p.refreshing
	p.mu.Unlock()

	tok, exp, err := p.doRefresh(ctx)

	p.mu.Lock()
	p.refreshing = nil
	close(ch)
	if err != nil {
		p.refreshErr = err
		p.mu.Unlock()
		return "", err
	}
	p.accessTok = tok
	p.expiresAt = exp
	p.refreshErr = nil
	p.mu.Unlock()
	return tok, nil
}

// tokenResponse covers the standard RFC 6749 fields we care about. The
// upstream may include other fields (refresh_token rotation, scope, etc.) —
// we ignore them.
type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
}

// doRefresh performs a single refresh-token grant. Returns the new access
// token and an absolute expiry timestamp. Network errors are wrapped so the
// caller can tell them apart from upstream-rejection errors.
func (p *OAuth2Refresh) doRefresh(ctx context.Context) (string, time.Time, error) {
	form := url.Values{
		"client_id":     {p.clientID},
		"client_secret": {p.clientSecret},
		"refresh_token": {p.refreshToken},
		"grant_type":    {"refresh_token"},
	}
	req, err := http.NewRequestWithContext(ctx, "POST", p.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("token request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		// Truncate the body in errors so a noisy upstream doesn't pollute logs.
		snippet := string(body)
		if len(snippet) > 256 {
			snippet = snippet[:256] + "..."
		}
		return "", time.Time{}, fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, snippet)
	}

	var t tokenResponse
	if err := json.Unmarshal(body, &t); err != nil {
		return "", time.Time{}, fmt.Errorf("decode token response: %w", err)
	}
	if t.AccessToken == "" {
		return "", time.Time{}, errors.New("token response had empty access_token")
	}

	lifetime := time.Duration(t.ExpiresIn) * time.Second
	if lifetime <= 0 {
		lifetime = fallbackTokenLifetime
	}
	return t.AccessToken, time.Now().Add(lifetime), nil
}
