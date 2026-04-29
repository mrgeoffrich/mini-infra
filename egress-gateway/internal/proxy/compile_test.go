package proxy

import (
	"testing"

	"github.com/sirupsen/logrus"
	acl "github.com/stripe/smokescreen/pkg/smokescreen/acl/v1"
)

func TestCompileACL_EmptySnapshot(t *testing.T) {
	snap := &RulesSnapshot{Version: 1, StackPolicies: map[string]StackPolicyEntry{}}
	logger := logrus.New()
	compiled, err := CompileACL(logger, snap)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if compiled == nil {
		t.Fatal("expected non-nil ACL")
	}
	if len(compiled.Rules) != 0 {
		t.Errorf("expected 0 rules, got %d", len(compiled.Rules))
	}
	// Default rule should be Report (permissive).
	if compiled.DefaultRule == nil {
		t.Fatal("expected non-nil DefaultRule")
	}
	if compiled.DefaultRule.Policy != acl.Report {
		t.Errorf("expected default policy=Report, got %v", compiled.DefaultRule.Policy)
	}
}

func TestCompileACL_DetectMode(t *testing.T) {
	snap := &RulesSnapshot{
		Version: 2,
		StackPolicies: map[string]StackPolicyEntry{
			"stack-abc": {
				Mode:          "detect",
				DefaultAction: "allow",
				Rules: []EgressRuleEntry{
					{ID: "r1", Pattern: "*.example.com", Action: "allow", Targets: []string{}},
					{ID: "r2", Pattern: "api.example.org", Action: "allow", Targets: []string{}},
				},
			},
		},
	}
	compiled, err := CompileACL(logrus.New(), snap)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rule, ok := compiled.Rules["stack-abc"]
	if !ok {
		t.Fatal("expected rule for stack-abc")
	}
	// detect mode → Report
	if rule.Policy != acl.Report {
		t.Errorf("expected Report policy for detect mode, got %v", rule.Policy)
	}
	// Two allow globs
	if len(rule.DomainGlobs) != 2 {
		t.Errorf("expected 2 domain globs, got %d: %v", len(rule.DomainGlobs), rule.DomainGlobs)
	}
}

func TestCompileACL_EnforceMode(t *testing.T) {
	snap := &RulesSnapshot{
		Version: 3,
		StackPolicies: map[string]StackPolicyEntry{
			"stack-xyz": {
				Mode:          "enforce",
				DefaultAction: "block",
				Rules: []EgressRuleEntry{
					{ID: "r1", Pattern: "api.safe.io", Action: "allow", Targets: []string{}},
					{ID: "r2", Pattern: "badsite.com", Action: "block", Targets: []string{}},
				},
			},
		},
	}
	compiled, err := CompileACL(logrus.New(), snap)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rule := compiled.Rules["stack-xyz"]
	if rule.Policy != acl.Enforce {
		t.Errorf("expected Enforce policy, got %v", rule.Policy)
	}
	// Only the allow rule should appear in DomainGlobs.
	if len(rule.DomainGlobs) != 1 {
		t.Errorf("expected 1 allow glob, got %d: %v", len(rule.DomainGlobs), rule.DomainGlobs)
	}
	if rule.DomainGlobs[0] != "api.safe.io" {
		t.Errorf("expected glob 'api.safe.io', got %q", rule.DomainGlobs[0])
	}
}

func TestParseRulesSnapshot(t *testing.T) {
	raw := []byte(`{
		"version": 5,
		"stackPolicies": {
			"s1": {
				"mode": "detect",
				"defaultAction": "allow",
				"rules": [
					{"id":"r1","pattern":"*.io","action":"allow","targets":[]}
				]
			}
		}
	}`)
	snap, err := ParseRulesSnapshot(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if snap.Version != 5 {
		t.Errorf("version: want 5, got %d", snap.Version)
	}
	if len(snap.StackPolicies) != 1 {
		t.Errorf("expected 1 stack policy, got %d", len(snap.StackPolicies))
	}
}

func TestParseRulesSnapshot_Invalid(t *testing.T) {
	_, err := ParseRulesSnapshot([]byte(`not json`))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}
