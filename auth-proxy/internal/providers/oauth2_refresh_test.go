package providers

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newOAuthFixture(t *testing.T, handler http.HandlerFunc) (*OAuth2Refresh, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	p := NewOAuth2Refresh(OAuth2Config{
		Name:         "gws/default",
		TokenURL:     srv.URL,
		ClientID:     "cid",
		ClientSecret: "csec",
		RefreshToken: "rtok",
		HTTPClient:   srv.Client(),
	})
	return p, srv
}

func TestOAuth2_apply_sets_bearer_from_minted_token(t *testing.T) {
	p, _ := newOAuthFixture(t, func(w http.ResponseWriter, r *http.Request) {
		// Sanity-check the request shape.
		if r.Method != "POST" {
			t.Errorf("method: got %s", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/x-www-form-urlencoded" {
			t.Errorf("content-type: got %q", ct)
		}
		_ = r.ParseForm()
		if r.PostForm.Get("grant_type") != "refresh_token" {
			t.Errorf("grant_type: got %q", r.PostForm.Get("grant_type"))
		}
		if r.PostForm.Get("refresh_token") != "rtok" {
			t.Errorf("refresh_token: got %q", r.PostForm.Get("refresh_token"))
		}
		fmt.Fprint(w, `{"access_token":"AT-1","expires_in":3600}`)
	})

	h, err := p.Apply(context.Background())
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := h.Get("Authorization"); got != "Bearer AT-1" {
		t.Errorf("authorization: got %q", got)
	}
}

func TestOAuth2_caches_token_until_near_expiry(t *testing.T) {
	var calls int32
	p, _ := newOAuthFixture(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		fmt.Fprint(w, `{"access_token":"AT","expires_in":3600}`)
	})

	for i := range 5 {
		if _, err := p.Apply(context.Background()); err != nil {
			t.Fatalf("apply %d: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected 1 token-endpoint call, got %d", got)
	}
}

func TestOAuth2_refreshes_when_near_expiry(t *testing.T) {
	var calls int32
	p, _ := newOAuthFixture(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		// expires_in=10 -> already past the 60s pre-expiry window, so each
		// call has to refresh.
		fmt.Fprint(w, `{"access_token":"AT","expires_in":10}`)
	})

	for i := range 3 {
		if _, err := p.Apply(context.Background()); err != nil {
			t.Fatalf("apply %d: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Errorf("expected 3 refreshes, got %d", got)
	}
}

func TestOAuth2_single_flight_under_concurrent_load(t *testing.T) {
	var calls int32
	p, _ := newOAuthFixture(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		// Hold the response so callers stack up behind the in-flight refresh.
		time.Sleep(50 * time.Millisecond)
		fmt.Fprint(w, `{"access_token":"AT","expires_in":3600}`)
	})

	const N = 20
	var wg sync.WaitGroup
	wg.Add(N)
	for range N {
		go func() {
			defer wg.Done()
			if _, err := p.Apply(context.Background()); err != nil {
				t.Errorf("apply: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected 1 token-endpoint call (single-flight), got %d", got)
	}
}

func TestOAuth2_propagates_upstream_4xx(t *testing.T) {
	p, _ := newOAuthFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":"invalid_grant"}`)
	})

	_, err := p.Apply(context.Background())
	if err == nil {
		t.Fatal("expected error from 400 response")
	}
	if !contains(err.Error(), "400") || !contains(err.Error(), "invalid_grant") {
		t.Errorf("error should mention status and body: %v", err)
	}
}

func TestOAuth2_empty_access_token_is_an_error(t *testing.T) {
	p, _ := newOAuthFixture(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"access_token":"","expires_in":3600}`)
	})

	_, err := p.Apply(context.Background())
	if err == nil {
		t.Fatal("expected error for empty access_token")
	}
}

func TestOAuth2_falls_back_to_default_lifetime_when_expires_in_missing(t *testing.T) {
	p, _ := newOAuthFixture(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"access_token":"AT"}`)
	})
	if _, err := p.Apply(context.Background()); err != nil {
		t.Fatalf("apply: %v", err)
	}
	// Validate via internal state: cache has plausibly-far expiry.
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Until(p.expiresAt) < 30*time.Minute {
		t.Errorf("expected fallback ~1h lifetime, got %v", time.Until(p.expiresAt))
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (func() bool {
		for i := 0; i+len(substr) <= len(s); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	})()
}
