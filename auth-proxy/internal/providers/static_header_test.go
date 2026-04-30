package providers

import (
	"context"
	"testing"
)

func TestStaticHeader_apply_returns_configured_headers(t *testing.T) {
	p := NewStaticHeader("anthropic/team-foo", map[string]string{
		"x-api-key":         "sk-secret",
		"anthropic-version": "2023-06-01",
	})
	h, err := p.Apply(context.Background())
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := h.Get("x-api-key"); got != "sk-secret" {
		t.Errorf("x-api-key: got %q", got)
	}
	if got := h.Get("anthropic-version"); got != "2023-06-01" {
		t.Errorf("anthropic-version: got %q", got)
	}
}

func TestStaticHeader_apply_returns_clone(t *testing.T) {
	p := NewStaticHeader("p/t", map[string]string{"x-api-key": "v1"})
	h, _ := p.Apply(context.Background())
	h.Set("x-api-key", "tampered")

	h2, _ := p.Apply(context.Background())
	if got := h2.Get("x-api-key"); got != "v1" {
		t.Errorf("internal headers were mutated: got %q", got)
	}
}

func TestStaticHeader_name(t *testing.T) {
	p := NewStaticHeader("github/org-acme", map[string]string{"Authorization": "Bearer x"})
	if p.Name() != "github/org-acme" {
		t.Errorf("name: got %q", p.Name())
	}
}
