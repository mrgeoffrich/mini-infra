// Package config loads and validates the YAML config file. Tokens reference
// env vars via ${VAR} interpolation; loading fails loudly if a referenced var
// is unset, so a bad deployment can never end up sending an empty Authorization
// header to an upstream.
package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the on-disk shape of the auth-proxy config file.
type Config struct {
	Listen    string               `yaml:"listen"`
	Providers map[string]*Provider `yaml:"providers"`
}

// Provider describes how the proxy should treat a single upstream service.
type Provider struct {
	// Type selects the credential strategy: "static_header" or "oauth2_refresh".
	Type string `yaml:"type"`

	// Upstream is the base URL the proxy forwards requests to.
	Upstream string `yaml:"upstream"`

	// OAuth is required when Type is "oauth2_refresh".
	OAuth *OAuthConfig `yaml:"oauth,omitempty"`

	// Tenants holds per-tenant credentials. The path segment after the
	// provider must match a key here.
	Tenants map[string]*Tenant `yaml:"tenants"`
}

// OAuthConfig holds parameters shared by all tenants of an oauth2_refresh
// provider.
type OAuthConfig struct {
	TokenURL string `yaml:"token_url"`
}

// Tenant holds the secrets and per-call config for one tenant of one provider.
// The fields used depend on the provider's Type.
type Tenant struct {
	// static_header: the headers to set on every forwarded request.
	Headers map[string]string `yaml:"headers,omitempty"`

	// oauth2_refresh: the OAuth client and refresh token. Access tokens are
	// minted on demand and cached in memory.
	ClientID     string `yaml:"client_id,omitempty"`
	ClientSecret string `yaml:"client_secret,omitempty"`
	RefreshToken string `yaml:"refresh_token,omitempty"`
}

// ProviderType constants for stricter checks elsewhere.
const (
	TypeStaticHeader   = "static_header"
	TypeOAuth2Refresh  = "oauth2_refresh"
	defaultListen      = ":8080"
	tenantPattern      = `^[a-z0-9][a-z0-9-]*$`
)

var (
	envVarPattern = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)
	tenantRegex   = regexp.MustCompile(tenantPattern)
)

// Load reads, expands, parses, and validates the config at path.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return parse(raw)
}

// parse is broken out from Load so tests can drive it without touching disk.
func parse(raw []byte) (*Config, error) {
	expanded, err := expandEnv(string(raw))
	if err != nil {
		return nil, err
	}

	var cfg Config
	if err := yaml.Unmarshal([]byte(expanded), &cfg); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// expandEnv replaces every ${VAR} reference with os.Getenv(VAR), failing if
// any referenced var is unset or empty. We dedupe and sort the missing list so
// the error message is stable.
func expandEnv(s string) (string, error) {
	missing := map[string]struct{}{}
	out := envVarPattern.ReplaceAllStringFunc(s, func(match string) string {
		name := match[2 : len(match)-1]
		val := os.Getenv(name)
		if val == "" {
			missing[name] = struct{}{}
		}
		return val
	})
	if len(missing) > 0 {
		names := make([]string, 0, len(missing))
		for n := range missing {
			names = append(names, n)
		}
		sort.Strings(names)
		return "", fmt.Errorf("required env vars not set: %s", strings.Join(names, ", "))
	}
	return out, nil
}

func (c *Config) validate() error {
	if c.Listen == "" {
		c.Listen = defaultListen
	}
	if len(c.Providers) == 0 {
		return fmt.Errorf("no providers configured")
	}
	for name, p := range c.Providers {
		if err := p.validate(name); err != nil {
			return err
		}
	}
	return nil
}

func (p *Provider) validate(name string) error {
	switch p.Type {
	case TypeStaticHeader, TypeOAuth2Refresh:
		// ok
	case "":
		return fmt.Errorf("provider %q: missing type", name)
	default:
		return fmt.Errorf("provider %q: unknown type %q (want %q or %q)", name, p.Type, TypeStaticHeader, TypeOAuth2Refresh)
	}

	if p.Upstream == "" {
		return fmt.Errorf("provider %q: missing upstream", name)
	}
	if u, err := url.Parse(p.Upstream); err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("provider %q: upstream %q is not a valid absolute URL", name, p.Upstream)
	}
	if len(p.Tenants) == 0 {
		return fmt.Errorf("provider %q: at least one tenant is required", name)
	}

	if p.Type == TypeOAuth2Refresh {
		if p.OAuth == nil || p.OAuth.TokenURL == "" {
			return fmt.Errorf("provider %q: oauth2_refresh requires oauth.token_url", name)
		}
		if u, err := url.Parse(p.OAuth.TokenURL); err != nil || u.Scheme == "" || u.Host == "" {
			return fmt.Errorf("provider %q: oauth.token_url %q is not a valid absolute URL", name, p.OAuth.TokenURL)
		}
	}

	for tname, t := range p.Tenants {
		if !tenantRegex.MatchString(tname) {
			return fmt.Errorf("provider %q tenant %q: must match %s", name, tname, tenantPattern)
		}
		if err := t.validate(name, tname, p.Type); err != nil {
			return err
		}
	}
	return nil
}

func (t *Tenant) validate(provider, tenant, ptype string) error {
	switch ptype {
	case TypeStaticHeader:
		if len(t.Headers) == 0 {
			return fmt.Errorf("provider %q tenant %q: static_header requires at least one header", provider, tenant)
		}
		for hk, hv := range t.Headers {
			if hk == "" || hv == "" {
				return fmt.Errorf("provider %q tenant %q: empty header key or value", provider, tenant)
			}
		}
	case TypeOAuth2Refresh:
		if t.ClientID == "" || t.ClientSecret == "" || t.RefreshToken == "" {
			return fmt.Errorf("provider %q tenant %q: oauth2_refresh requires client_id, client_secret, and refresh_token", provider, tenant)
		}
	}
	return nil
}
