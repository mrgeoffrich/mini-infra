// Package fw manages host firewall rules for the egress-fw-agent.
package fw

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// Mode controls whether the firewall drops packets or only logs them.
type Mode string

const (
	ModeObserve = Mode("observe") // NFLOG only, no DROP
	ModeEnforce = Mode("enforce") // NFLOG + DROP
)

const (
	nflogGroup  = "1"
	nflogPrefix = "mini-infra-egress-drop "
	chain       = "DOCKER-USER"
)

// execCommand is a function-pointer indirection so tests can substitute a mock.
var execCommand = func(name string, args ...string) *exec.Cmd {
	return exec.Command(name, args...)
}

// ipsetName returns the canonical ipset name for an environment.
func ipsetName(env string) string {
	return "managed-" + env
}

// applyEnvRules idempotently installs the per-env iptables rule block.
//
// Rule order (installed via -A / append):
//  1. Established/related — return traffic for in-bridge flows.
//  2. Allow within env bridge CIDR (peers, gateway, bypass).
//  3. NFLOG — always present in both observe and enforce.
//  4. DROP  — only in enforce mode.
func applyEnvRules(env, bridgeCidr string, mode Mode) error {
	set := ipsetName(env)

	// Rule 1: allow established/related
	rule1 := []string{chain,
		"-m", "set", "--match-set", set, "src",
		"-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED",
		"-j", "ACCEPT",
	}
	if err := ensureIptablesRule(rule1); err != nil {
		return fmt.Errorf("applyEnvRules: rule1 (established): %w", err)
	}

	// Rule 2: allow within bridge CIDR
	rule2 := []string{chain,
		"-m", "set", "--match-set", set, "src",
		"-d", bridgeCidr,
		"-j", "ACCEPT",
	}
	if err := ensureIptablesRule(rule2); err != nil {
		return fmt.Errorf("applyEnvRules: rule2 (bridge accept): %w", err)
	}

	// Rule 3: NFLOG (always present)
	rule3 := []string{chain,
		"-m", "set", "--match-set", set, "src",
		"-j", "NFLOG",
		"--nflog-group", nflogGroup,
		"--nflog-prefix", nflogPrefix,
	}
	if err := ensureIptablesRule(rule3); err != nil {
		return fmt.Errorf("applyEnvRules: rule3 (nflog): %w", err)
	}

	// Rule 4: DROP — only in enforce mode
	if mode == ModeEnforce {
		rule4 := []string{chain,
			"-m", "set", "--match-set", set, "src",
			"-j", "DROP",
		}
		if err := ensureIptablesRule(rule4); err != nil {
			return fmt.Errorf("applyEnvRules: rule4 (drop): %w", err)
		}
	}

	return nil
}

// maxRemoveIterations caps the loop in removeEnvRules to prevent an infinite
// loop if the kernel state is corrupted or a concurrent insert race occurs.
const maxRemoveIterations = 100

// removeEnvRules removes all iptables rules matching this env's ipset.
// Errors are accumulated but do not halt removal of remaining rules.
func removeEnvRules(env string) error {
	set := ipsetName(env)
	var errs []string
	capExceeded := true

	// Keep deleting matching rules until none remain, with an upper bound.
	for i := 0; i < maxRemoveIterations; i++ {
		removed, err := deleteOneIptablesRuleBySet(set)
		if err != nil {
			errs = append(errs, err.Error())
			capExceeded = false
			break
		}
		if !removed {
			capExceeded = false
			break
		}
	}

	if capExceeded {
		return fmt.Errorf("removeEnvRules: too many iterations removing rules for env=%s", env)
	}

	if len(errs) > 0 {
		return fmt.Errorf("removeEnvRules(%s): %s", env, strings.Join(errs, "; "))
	}
	return nil
}

// ensureIptablesRule adds a rule (via -A) only if it does not already exist (-C check).
// argv must NOT include the leading "iptables" token — this function adds it.
func ensureIptablesRule(argv []string) error {
	// Check whether the rule already exists.
	checkArgs := append([]string{"-C"}, argv...)
	cmd := execCommand("iptables", checkArgs...)
	if err := cmd.Run(); err == nil {
		// Rule already present — idempotent success.
		return nil
	}

	// Rule missing — append it.
	addArgs := append([]string{"-A"}, argv...)
	out, err := execCommand("iptables", addArgs...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("iptables -A %v: %w (%s)", argv, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// deleteOneIptablesRuleBySet deletes the first rule in DOCKER-USER that references
// the given ipset name. Returns (true, nil) when a rule was deleted,
// (false, nil) when no matching rule was found, or (false, err) on failure.
func deleteOneIptablesRuleBySet(set string) (bool, error) {
	// List rules with line numbers, find one that references the set.
	out, err := execCommand("iptables", "-L", chain, "--line-numbers", "-n").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("iptables -L: %w (%s)", err, strings.TrimSpace(string(out)))
	}

	lineNum := ""
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "match-set "+set) {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				n, parseErr := strconv.Atoi(fields[0])
				if parseErr != nil || n <= 0 {
					// Non-numeric or non-positive first field — skip (header line,
					// blank line, or iptables version formatting difference).
					continue
				}
				lineNum = fields[0]
				break
			}
		}
	}

	if lineNum == "" {
		return false, nil
	}

	delOut, err := execCommand("iptables", "-D", chain, lineNum).CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("iptables -D %s %s: %w (%s)", chain, lineNum, err, strings.TrimSpace(string(delOut)))
	}
	return true, nil
}
