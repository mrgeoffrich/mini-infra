package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// applyFn returns the headers to inject on a request. It can fail (e.g.
// OAuth refresh failure). The handler resolves headers up-front so it can
// return errors cleanly — the ReverseProxy.Director can't.
type applyFn func(ctx context.Context) (http.Header, error)

type provider struct {
	upstream *url.URL
	apply    applyFn
}

func mustParseURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		log.Fatalf("bad url %q: %v", s, err)
	}
	return u
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func staticHeaderApply(headers map[string]string) applyFn {
	h := http.Header{}
	for k, v := range headers {
		h.Set(k, v)
	}
	return func(_ context.Context) (http.Header, error) {
		return h.Clone(), nil
	}
}

// oauthState holds the refresh-token state for a single OAuth tenant. It
// caches the access token and uses a single-flight mutex to ensure a burst
// of requests doesn't fan out into N parallel refresh calls.
type oauthState struct {
	mu           sync.Mutex
	tokenURL     string
	clientID     string
	clientSecret string
	refreshToken string
	accessTok    string
	expiresAt    time.Time
	refreshing   chan struct{}
	refreshErr   error
}

func (s *oauthState) getToken(ctx context.Context) (string, error) {
	s.mu.Lock()
	if s.accessTok != "" && time.Until(s.expiresAt) > 60*time.Second {
		tok := s.accessTok
		s.mu.Unlock()
		return tok, nil
	}
	if s.refreshing != nil {
		ch := s.refreshing
		s.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.refreshErr != nil {
			return "", s.refreshErr
		}
		return s.accessTok, nil
	}
	s.refreshing = make(chan struct{})
	ch := s.refreshing
	s.mu.Unlock()

	tok, exp, err := s.doRefresh(ctx)

	s.mu.Lock()
	s.refreshing = nil
	close(ch)
	if err != nil {
		s.refreshErr = err
		s.mu.Unlock()
		return "", err
	}
	s.accessTok = tok
	s.expiresAt = exp
	s.refreshErr = nil
	s.mu.Unlock()
	return tok, nil
}

func (s *oauthState) doRefresh(ctx context.Context) (string, time.Time, error) {
	form := url.Values{
		"client_id":     {s.clientID},
		"client_secret": {s.clientSecret},
		"refresh_token": {s.refreshToken},
		"grant_type":    {"refresh_token"},
	}
	req, err := http.NewRequestWithContext(ctx, "POST", s.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("token request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", time.Time{}, fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, string(body))
	}

	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", time.Time{}, fmt.Errorf("decode token response: %w", err)
	}
	if tok.AccessToken == "" {
		return "", time.Time{}, fmt.Errorf("empty access_token in response")
	}
	if tok.ExpiresIn <= 0 {
		tok.ExpiresIn = 3600
	}
	log.Printf("oauth: minted new access token, expires in %ds", tok.ExpiresIn)
	return tok.AccessToken, time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second), nil
}

func oauthApply(s *oauthState) applyFn {
	return func(ctx context.Context) (http.Header, error) {
		tok, err := s.getToken(ctx)
		if err != nil {
			return nil, err
		}
		h := http.Header{}
		h.Set("Authorization", "Bearer "+tok)
		return h, nil
	}
}

func loadProviders() map[string]*provider {
	providers := map[string]*provider{}

	if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
		upstream := envOr("ANTHROPIC_UPSTREAM", "https://api.anthropic.com")
		providers["anthropic"] = &provider{
			upstream: mustParseURL(upstream),
			apply: staticHeaderApply(map[string]string{
				"x-api-key": key,
			}),
		}
		log.Printf("registered: anthropic -> %s (static_header)", upstream)
	}

	if pat := os.Getenv("GITHUB_PAT"); pat != "" {
		upstream := envOr("GITHUB_UPSTREAM", "https://api.github.com")
		providers["github"] = &provider{
			upstream: mustParseURL(upstream),
			apply: staticHeaderApply(map[string]string{
				"Authorization": "Bearer " + pat,
			}),
		}
		log.Printf("registered: github -> %s (static_header)", upstream)
	}

	if cid := os.Getenv("GOOGLE_CLIENT_ID"); cid != "" {
		secret := os.Getenv("GOOGLE_CLIENT_SECRET")
		refresh := os.Getenv("GOOGLE_REFRESH_TOKEN")
		if secret == "" || refresh == "" {
			log.Fatal("GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET or GOOGLE_REFRESH_TOKEN is missing")
		}
		upstream := envOr("GOOGLE_UPSTREAM", "https://www.googleapis.com")
		tokenURL := envOr("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token")
		state := &oauthState{
			tokenURL:     tokenURL,
			clientID:     cid,
			clientSecret: secret,
			refreshToken: refresh,
		}
		providers["gws"] = &provider{
			upstream: mustParseURL(upstream),
			apply:    oauthApply(state),
		}
		log.Printf("registered: gws -> %s (oauth2_refresh via %s)", upstream, tokenURL)
	}

	return providers
}

func main() {
	providers := loadProviders()
	if len(providers) == 0 {
		log.Fatal("no providers configured (set ANTHROPIC_API_KEY, GITHUB_PAT, and/or GOOGLE_CLIENT_ID)")
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 3)
		if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
			http.Error(w, "expected /<provider>/<tenant>/...", http.StatusBadRequest)
			return
		}
		providerName, tenant := parts[0], parts[1]
		rest := "/"
		if len(parts) == 3 {
			rest = "/" + parts[2]
		}

		p, ok := providers[providerName]
		if !ok {
			http.Error(w, "unknown provider: "+providerName, http.StatusNotFound)
			return
		}

		// Resolve auth headers up-front so OAuth refresh errors return cleanly.
		injected, err := p.apply(r.Context())
		if err != nil {
			log.Printf("auth apply failed for %s/%s: %v", providerName, tenant, err)
			http.Error(w, "auth provider error: "+err.Error(), http.StatusBadGateway)
			return
		}

		log.Printf("%s/%s %s %s -> %s%s", providerName, tenant, r.Method, r.URL.Path, p.upstream, rest)

		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL.Scheme = p.upstream.Scheme
				req.URL.Host = p.upstream.Host
				req.Host = p.upstream.Host
				req.URL.Path = rest
				req.URL.RawPath = ""

				req.Header.Del("Authorization")
				req.Header.Del("X-Api-Key")

				for k, vs := range injected {
					req.Header.Del(k)
					for _, v := range vs {
						req.Header.Add(k, v)
					}
				}
			},
		}
		proxy.ServeHTTP(w, r)
	})

	addr := ":8080"
	log.Printf("auth-proxy-poc listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
