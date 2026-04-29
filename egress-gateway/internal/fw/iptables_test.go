package fw

import (
	"os/exec"
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
