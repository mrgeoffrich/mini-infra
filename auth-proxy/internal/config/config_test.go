package config

import (
	"strings"
	"testing"
)

func TestParse_static_header_minimal(t *testing.T) {
	t.Setenv("ANTHROPIC_KEY", "sk-secret")
	yaml := `
listen: ":8080"
providers:
  anthropic:
    type: static_header
    upstream: https://api.anthropic.com
    tenants:
      team-foo:
        headers:
          x-api-key: ${ANTHROPIC_KEY}
`
	cfg, err := parse([]byte(yaml))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Listen != ":8080" {
		t.Errorf("listen: got %q", cfg.Listen)
	}
	got := cfg.Providers["anthropic"].Tenants["team-foo"].Headers["x-api-key"]
	if got != "sk-secret" {
		t.Errorf("env var did not expand: got %q", got)
	}
}

func TestParse_oauth2_refresh(t *testing.T) {
	t.Setenv("CID", "client-id")
	t.Setenv("CSEC", "client-secret")
	t.Setenv("RTOK", "1//refresh")
	yaml := `
providers:
  gws:
    type: oauth2_refresh
    upstream: https://www.googleapis.com
    oauth:
      token_url: https://oauth2.googleapis.com/token
    tenants:
      default:
        client_id: ${CID}
        client_secret: ${CSEC}
        refresh_token: ${RTOK}
`
	cfg, err := parse([]byte(yaml))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	tn := cfg.Providers["gws"].Tenants["default"]
	if tn.ClientID != "client-id" || tn.ClientSecret != "client-secret" || tn.RefreshToken != "1//refresh" {
		t.Errorf("tenant fields wrong: %+v", tn)
	}
	if cfg.Listen != ":8080" {
		t.Errorf("default listen not applied: %q", cfg.Listen)
	}
}

func TestParse_missing_env_var_fails_loudly(t *testing.T) {
	yaml := `
providers:
  p:
    type: static_header
    upstream: https://example.com
    tenants:
      default:
        headers:
          Authorization: Bearer ${NOT_SET_VAR}
`
	_, err := parse([]byte(yaml))
	if err == nil {
		t.Fatal("expected error for missing env var")
	}
	if !strings.Contains(err.Error(), "NOT_SET_VAR") {
		t.Errorf("error should name the missing var: %v", err)
	}
}

func TestParse_invalid_provider_type(t *testing.T) {
	yaml := `
providers:
  p:
    type: bogus
    upstream: https://example.com
    tenants: {default: {headers: {x: y}}}
`
	_, err := parse([]byte(yaml))
	if err == nil || !strings.Contains(err.Error(), "unknown type") {
		t.Errorf("expected unknown-type error, got: %v", err)
	}
}

func TestParse_invalid_upstream(t *testing.T) {
	yaml := `
providers:
  p:
    type: static_header
    upstream: not-a-url
    tenants: {default: {headers: {x: y}}}
`
	_, err := parse([]byte(yaml))
	if err == nil || !strings.Contains(err.Error(), "valid absolute URL") {
		t.Errorf("expected upstream-URL error, got: %v", err)
	}
}

func TestParse_invalid_tenant_name(t *testing.T) {
	yaml := `
providers:
  p:
    type: static_header
    upstream: https://example.com
    tenants:
      "Bad Tenant Name":
        headers: {x: y}
`
	_, err := parse([]byte(yaml))
	if err == nil || !strings.Contains(err.Error(), "tenant") {
		t.Errorf("expected tenant-name error, got: %v", err)
	}
}

func TestParse_oauth2_missing_token_url(t *testing.T) {
	t.Setenv("CID", "x")
	t.Setenv("CSEC", "y")
	t.Setenv("RTOK", "z")
	yaml := `
providers:
  p:
    type: oauth2_refresh
    upstream: https://example.com
    tenants:
      default:
        client_id: ${CID}
        client_secret: ${CSEC}
        refresh_token: ${RTOK}
`
	_, err := parse([]byte(yaml))
	if err == nil || !strings.Contains(err.Error(), "token_url") {
		t.Errorf("expected token_url error, got: %v", err)
	}
}

func TestParse_static_header_requires_headers(t *testing.T) {
	yaml := `
providers:
  p:
    type: static_header
    upstream: https://example.com
    tenants:
      default: {}
`
	_, err := parse([]byte(yaml))
	if err == nil || !strings.Contains(err.Error(), "at least one header") {
		t.Errorf("expected headers-required error, got: %v", err)
	}
}

func TestParse_no_providers(t *testing.T) {
	yaml := `listen: ":8080"`
	_, err := parse([]byte(yaml))
	if err == nil || !strings.Contains(err.Error(), "no providers") {
		t.Errorf("expected no-providers error, got: %v", err)
	}
}

func TestExpandEnv_lists_all_missing_vars_sorted(t *testing.T) {
	_, err := expandEnv("${ZETA} ${ALPHA} ${BETA}")
	if err == nil {
		t.Fatal("expected error")
	}
	want := "ALPHA, BETA, ZETA"
	if !strings.Contains(err.Error(), want) {
		t.Errorf("expected %q in error, got: %v", want, err)
	}
}
