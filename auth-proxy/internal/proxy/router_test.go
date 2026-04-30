package proxy

import (
	"errors"
	"testing"
)

func TestParsePath_valid(t *testing.T) {
	cases := []struct {
		path string
		want Route
	}{
		{"/anthropic/team-foo/v1/messages", Route{"anthropic", "team-foo", "/v1/messages"}},
		{"/github/org-acme/repos/x/y", Route{"github", "org-acme", "/repos/x/y"}},
		{"/gws/default/", Route{"gws", "default", "/"}},
		{"/gws/default", Route{"gws", "default", "/"}},
		{"/gws/default/discovery/v1/apis/drive/v3/rest", Route{"gws", "default", "/discovery/v1/apis/drive/v3/rest"}},
	}
	for _, c := range cases {
		got, err := ParsePath(c.path)
		if err != nil {
			t.Errorf("%s: %v", c.path, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.path, got, c.want)
		}
	}
}

func TestParsePath_bad_shape(t *testing.T) {
	cases := []string{
		"/",
		"/anthropic",
		"/anthropic/",
		"//default/x",
	}
	for _, p := range cases {
		_, err := ParsePath(p)
		if !errors.Is(err, ErrBadPath) {
			t.Errorf("%q: got %v, want ErrBadPath", p, err)
		}
	}
}

func TestParsePath_invalid_tenant(t *testing.T) {
	cases := []string{
		"/anthropic/Team-Foo/x", // uppercase
		"/anthropic/-bad/x",     // leading dash
		"/anthropic/has_underscore/x",
		"/anthropic/has.dot/x",
	}
	for _, p := range cases {
		_, err := ParsePath(p)
		if !errors.Is(err, ErrInvalidTenant) {
			t.Errorf("%q: got %v, want ErrInvalidTenant", p, err)
		}
	}
}
