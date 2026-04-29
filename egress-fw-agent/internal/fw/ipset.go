// Package fw manages host firewall rules for the egress-fw-agent.
package fw

import (
	"fmt"
	"os/exec"
	"strings"
)

// execIPSet is a function-pointer indirection so tests can substitute a mock.
// It must return a *exec.Cmd (or a *testCmd that implements the same interface).
var execIPSet = func(name string, args ...string) *exec.Cmd {
	return exec.Command(name, args...)
}

// ensureIpset creates the managed-<env> ipset if it does not already exist.
// Uses hash:ip type which supports individual IPv4 addresses.
func ensureIpset(env string) error {
	set := ipsetName(env)
	out, err := execIPSet("ipset", "create", set, "hash:ip", "family", "inet").CombinedOutput()
	if err != nil {
		// "set already exists" is a non-error for our idempotent semantics.
		s := string(out)
		if strings.Contains(s, "already exists") {
			return nil
		}
		return fmt.Errorf("ipset create %s: %w (%s)", set, err, strings.TrimSpace(s))
	}
	return nil
}

// destroyIpset destroys the managed-<env> ipset.
// If the set does not exist, this is a no-op.
func destroyIpset(env string) error {
	set := ipsetName(env)
	out, err := execIPSet("ipset", "destroy", set).CombinedOutput()
	if err != nil {
		s := string(out)
		if strings.Contains(s, "does not exist") {
			return nil
		}
		return fmt.Errorf("ipset destroy %s: %w (%s)", set, err, strings.TrimSpace(s))
	}
	return nil
}

// addManagedMember adds a single IPv4 address to the managed-<env> ipset.
// Idempotent: adding an existing member is a no-op.
func addManagedMember(env, ip string) error {
	set := ipsetName(env)
	out, err := execIPSet("ipset", "add", set, ip, "-exist").CombinedOutput()
	if err != nil {
		return fmt.Errorf("ipset add %s %s: %w (%s)", set, ip, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// delManagedMember removes a single IPv4 address from the managed-<env> ipset.
// Idempotent: removing a non-existent member is a no-op.
func delManagedMember(env, ip string) error {
	set := ipsetName(env)
	out, err := execIPSet("ipset", "del", set, ip, "-exist").CombinedOutput()
	if err != nil {
		return fmt.Errorf("ipset del %s %s: %w (%s)", set, ip, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// syncManaged atomically replaces the full membership of managed-<env> with ips.
// Uses the swap-and-destroy pattern:
//  1. Create a temp set with the desired members via `ipset restore`.
//  2. Swap temp → managed-<env> atomically.
//  3. Destroy the old set (which now has the stale name).
func syncManaged(env string, ips []string) error {
	set := ipsetName(env)
	tmpSet := set + "-tmp"

	// Build the ipset restore input for tmpSet.
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("create %s hash:ip family inet\n", tmpSet))
	for _, ip := range ips {
		sb.WriteString(fmt.Sprintf("add %s %s\n", tmpSet, ip))
	}

	// Feed restore input via stdin using a pipe.
	cmd := execIPSet("ipset", "restore")
	cmd.Stdin = strings.NewReader(sb.String())
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ipset restore for %s: %w (%s)", tmpSet, err, strings.TrimSpace(string(out)))
	}

	// Swap tmpSet ↔ set atomically.
	swapOut, err := execIPSet("ipset", "swap", tmpSet, set).CombinedOutput()
	if err != nil {
		_ = execIPSet("ipset", "destroy", tmpSet).Run()
		return fmt.Errorf("ipset swap %s %s: %w (%s)", tmpSet, set, err, strings.TrimSpace(string(swapOut)))
	}

	// Destroy old set (now named tmpSet after the swap).
	_ = execIPSet("ipset", "destroy", tmpSet).Run()

	return nil
}
