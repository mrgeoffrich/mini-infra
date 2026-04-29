package proxy

import (
	"encoding/json"
	"fmt"

	"github.com/sirupsen/logrus"
	acl "github.com/stripe/smokescreen/pkg/smokescreen/acl/v1"
)

// StackPolicyEntry mirrors the JSON shape pushed by EgressRulePusher
// (server/src/services/egress/egress-gateway-client.ts).
type StackPolicyEntry struct {
	Mode          string           `json:"mode"`          // "detect" | "enforce"
	DefaultAction string           `json:"defaultAction"` // "allow" | "block"
	Rules         []EgressRuleEntry `json:"rules"`
}

// EgressRuleEntry mirrors EgressRuleEntry in the TS client.
type EgressRuleEntry struct {
	ID      string   `json:"id"`
	Pattern string   `json:"pattern"`
	Action  string   `json:"action"`  // "allow" | "block"
	Targets []string `json:"targets"` // service names; [] = all
}

// RulesSnapshot is the full payload of POST /admin/rules.
type RulesSnapshot struct {
	Version       int                         `json:"version"`
	StackPolicies map[string]StackPolicyEntry `json:"stackPolicies"`
}

// CompileACL converts a RulesSnapshot into a Smokescreen *acl.ACL.
// Each stackId becomes a Smokescreen role.
// "detect" mode → Report (allow + log); "enforce" mode → Enforce (deny on miss).
func CompileACL(logger *logrus.Logger, snapshot *RulesSnapshot) (*acl.ACL, error) {
	compiled := &acl.ACL{
		Rules: make(map[string]acl.Rule),
		// Default rule: Report (allow everything, log) — safe default when a
		// role has no match in the map (e.g. unmanaged containers).
		DefaultRule: &acl.Rule{
			Policy: acl.Report,
		},
	}
	if logger != nil {
		compiled.Logger = logger
	} else {
		compiled.Logger = logrus.New()
	}

	for stackID, policy := range snapshot.StackPolicies {
		rule, err := compileRule(stackID, policy)
		if err != nil {
			return nil, fmt.Errorf("compile rule for stack %q: %w", stackID, err)
		}
		compiled.Rules[stackID] = rule
	}

	return compiled, nil
}

// ParseRulesSnapshot unmarshals raw JSON bytes into a RulesSnapshot.
func ParseRulesSnapshot(data []byte) (*RulesSnapshot, error) {
	var snap RulesSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("parse rules snapshot: %w", err)
	}
	return &snap, nil
}

// compileRule converts one StackPolicyEntry into an acl.Rule.
func compileRule(stackID string, policy StackPolicyEntry) (acl.Rule, error) {
	var enfPolicy acl.EnforcementPolicy
	switch policy.Mode {
	case "enforce":
		enfPolicy = acl.Enforce
	default:
		// "detect" or anything unrecognised → report mode (allow + log)
		enfPolicy = acl.Report
	}

	// Collect allowed domain globs from rules with action=="allow".
	// Denied patterns are enforced by setting defaultAction=block and
	// only listing the allow rules — Smokescreen's Enforce mode denies
	// anything not in DomainGlobs.
	// For Report mode, DomainGlobs drives "enforce_would_deny" logging.
	var allowGlobs []string
	for _, r := range policy.Rules {
		if r.Action == "allow" && r.Pattern != "" {
			allowGlobs = append(allowGlobs, r.Pattern)
		}
	}

	return acl.Rule{
		Project:     stackID,
		Policy:      enfPolicy,
		DomainGlobs: allowGlobs,
	}, nil
}
