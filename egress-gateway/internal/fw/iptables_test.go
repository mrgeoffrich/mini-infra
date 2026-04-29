package fw

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
	"testing"
)

// capturedIPTablesArgs captures the argv arrays passed to iptables calls.
var capturedIPTablesArgs [][]string

// mockIPTablesExec records calls and returns a no-op command.
func mockIPTablesExec(name string, args ...string) *exec.Cmd {
	capturedIPTablesArgs = append(capturedIPTablesArgs, append([]string{name}, args...))
	return exec.Command("true")
}

func setupIPTablesMock(t *testing.T) {
	t.Helper()
	capturedIPTablesArgs = nil
	orig := execCommand
	t.Cleanup(func() { execCommand = orig })
	execCommand = mockIPTablesExec
}

// TestApplyEnvRules_ObserveArgvArrays verifies that applyEnvRules in observe mode
// calls iptables with explicit argv arrays and does NOT produce a DROP rule.
func TestApplyEnvRules_ObserveArgvArrays(t *testing.T) {
	setupIPTablesMock(t)

	err := applyEnvRules("prod", "10.0.0.0/24", ModeObserve)
	if err != nil {
		// Expected: "iptables -C" returns non-zero for the check, then "-A" is called.
		// With our mock, both succeed. The error surface is internal.
		t.Logf("applyEnvRules returned error (ok in test): %v", err)
	}

	// At minimum, iptables must have been called.
	if len(capturedIPTablesArgs) == 0 {
		t.Fatal("expected iptables calls, got none")
	}

	// Verify no shell string interpolation: each invocation must have "iptables" as name.
	for _, call := range capturedIPTablesArgs {
		if call[0] != "iptables" {
			t.Errorf("expected command 'iptables', got %q", call[0])
		}
	}

	// In observe mode there must be no -j DROP call.
	for _, call := range capturedIPTablesArgs {
		for i, arg := range call {
			if arg == "-j" && i+1 < len(call) && call[i+1] == "DROP" {
				t.Errorf("observe mode must not produce -j DROP; got call: %v", call)
			}
		}
	}

	// Verify NFLOG is present in at least one call.
	foundNFLOG := false
	for _, call := range capturedIPTablesArgs {
		for _, arg := range call {
			if arg == "NFLOG" {
				foundNFLOG = true
			}
		}
	}
	if !foundNFLOG {
		t.Error("expected NFLOG target in observe mode, but none found")
	}
}

// TestApplyEnvRules_EnforceArgvArrays verifies that enforce mode adds a DROP rule.
func TestApplyEnvRules_EnforceArgvArrays(t *testing.T) {
	setupIPTablesMock(t)

	_ = applyEnvRules("prod", "10.0.0.0/24", ModeEnforce)

	foundDROP := false
	for _, call := range capturedIPTablesArgs {
		for i, arg := range call {
			if arg == "-j" && i+1 < len(call) && call[i+1] == "DROP" {
				foundDROP = true
			}
		}
	}
	if !foundDROP {
		t.Error("expected -j DROP in enforce mode, but none found")
	}
}

// TestApplyEnvRules_IpsetNameContainsEnv verifies the ipset name format.
func TestApplyEnvRules_IpsetNameContainsEnv(t *testing.T) {
	setupIPTablesMock(t)

	env := "staging"
	_ = applyEnvRules(env, "10.0.0.0/24", ModeObserve)

	expectedSet := "managed-" + env
	for _, call := range capturedIPTablesArgs {
		for _, arg := range call {
			if arg == expectedSet {
				return // found — pass
			}
		}
	}
	t.Errorf("expected ipset name %q to appear in iptables calls; calls: %v", expectedSet, capturedIPTablesArgs)
}

// TestApplyEnvRules_NoShellInterpolation verifies that no shell metacharacters
// appear as single arguments (they would indicate string interpolation).
func TestApplyEnvRules_NoShellInterpolation(t *testing.T) {
	setupIPTablesMock(t)

	_ = applyEnvRules("prod", "10.0.0.0/24", ModeObserve)

	shellMetaInArgs := []string{"&&", "||", ";", "|", "&", "`", "$(", "${", "sh -c"}
	for _, call := range capturedIPTablesArgs {
		for _, arg := range call {
			for _, meta := range shellMetaInArgs {
				if arg == meta {
					t.Errorf("found shell metacharacter %q as standalone arg in iptables call: %v", meta, call)
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// deleteOneIptablesRuleBySet — line-number validation (Critical 1)
// ---------------------------------------------------------------------------

// TestDeleteOneIptablesRuleBySet_MalformedLineNum verifies that non-numeric or
// non-positive first fields in iptables -L output do NOT produce an iptables -D call.
func TestDeleteOneIptablesRuleBySet_MalformedLineNum(t *testing.T) {
	const set = "managed-prod"

	// Build a fake iptables -L output where the matching line has a non-numeric
	// first field ("foo"), a blank first field (" "), and a header-like line.
	fakeOutput := strings.Join([]string{
		"Chain DOCKER-USER (policy ACCEPT)",
		"num  target     prot opt source               destination",
		"foo  bar  match-set " + set + " src",                 // non-numeric — must be skipped
		"   match-set " + set + " src baz",                    // leading space / blank first field
		"  0  ACCEPT  all  --  0.0.0.0/0  0.0.0.0/0  match-set " + set + " src", // first field "0" — non-positive
		"",
	}, "\n")

	var deleteCalled bool
	orig := execCommand
	t.Cleanup(func() { execCommand = orig })
	execCommand = func(name string, args ...string) *exec.Cmd {
		// Intercept iptables -L: return the fake output.
		if name == "iptables" && len(args) > 0 && args[0] == "-L" {
			cmd := exec.Command("cat")
			cmd.Stdin = bytes.NewBufferString(fakeOutput)
			return cmd
		}
		// Any -D call must not happen.
		if name == "iptables" && len(args) > 0 && args[0] == "-D" {
			deleteCalled = true
		}
		return exec.Command("true")
	}

	removed, err := deleteOneIptablesRuleBySet(set)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if removed {
		t.Error("expected removed=false (no valid line number found), got true")
	}
	if deleteCalled {
		t.Error("iptables -D must NOT be called when no valid positive integer line number is found")
	}
}

// ---------------------------------------------------------------------------
// removeEnvRules — iteration cap (Critical 3)
// ---------------------------------------------------------------------------

// TestRemoveEnvRules_IterationCap verifies that removeEnvRules returns an error
// when the same matching rule keeps appearing (simulating an unbounded delete loop).
func TestRemoveEnvRules_IterationCap(t *testing.T) {
	const env = "prod"
	set := ipsetName(env)

	// Build a fake iptables -L output that always shows the rule — the mock never
	// removes it, so the loop would be infinite without the cap.
	fakeOutput := fmt.Sprintf("Chain DOCKER-USER (policy ACCEPT)\nnum  target  prot  opt  source  destination\n1  ACCEPT  all  --  0.0.0.0/0  0.0.0.0/0  match-set %s src\n", set)

	orig := execCommand
	t.Cleanup(func() { execCommand = orig })
	execCommand = func(name string, args ...string) *exec.Cmd {
		if name == "iptables" && len(args) > 0 && args[0] == "-L" {
			cmd := exec.Command("cat")
			cmd.Stdin = bytes.NewBufferString(fakeOutput)
			return cmd
		}
		// -D calls succeed (exit 0) but the rule is never actually removed from
		// the fake output — it re-appears on the next -L call.
		return exec.Command("true")
	}

	err := removeEnvRules(env)
	if err == nil {
		t.Fatal("expected an error when iteration cap is exceeded, got nil")
	}
	if !strings.Contains(err.Error(), "too many iterations") {
		t.Errorf("expected 'too many iterations' in error, got: %v", err)
	}
}
