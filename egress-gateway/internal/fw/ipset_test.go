package fw

import (
	"os/exec"
	"testing"
)

// capturedIPSetArgs captures the argv arrays passed to ipset calls.
var capturedIPSetArgs [][]string

// mockIPSetExec records calls and returns a no-op command.
func mockIPSetExec(name string, args ...string) *exec.Cmd {
	capturedIPSetArgs = append(capturedIPSetArgs, append([]string{name}, args...))
	return exec.Command("true")
}

func setupIPSetMock(t *testing.T) {
	t.Helper()
	capturedIPSetArgs = nil
	orig := execIPSet
	t.Cleanup(func() { execIPSet = orig })
	execIPSet = mockIPSetExec
}

// TestAddManagedMember_ArgvArray verifies addManagedMember uses explicit argv.
func TestAddManagedMember_ArgvArray(t *testing.T) {
	setupIPSetMock(t)

	if err := addManagedMember("prod", "10.0.0.5"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(capturedIPSetArgs) == 0 {
		t.Fatal("expected ipset call, got none")
	}
	call := capturedIPSetArgs[0]
	// Must be: ipset add managed-prod 10.0.0.5 -exist
	if call[0] != "ipset" {
		t.Errorf("expected command 'ipset', got %q", call[0])
	}
	if call[1] != "add" {
		t.Errorf("expected subcommand 'add', got %q", call[1])
	}
	if call[2] != "managed-prod" {
		t.Errorf("expected set name 'managed-prod', got %q", call[2])
	}
	if call[3] != "10.0.0.5" {
		t.Errorf("expected ip '10.0.0.5', got %q", call[3])
	}
}

// TestDelManagedMember_ArgvArray verifies delManagedMember uses explicit argv.
func TestDelManagedMember_ArgvArray(t *testing.T) {
	setupIPSetMock(t)

	if err := delManagedMember("prod", "10.0.0.5"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(capturedIPSetArgs) == 0 {
		t.Fatal("expected ipset call, got none")
	}
	call := capturedIPSetArgs[0]
	if call[1] != "del" {
		t.Errorf("expected 'del', got %q", call[1])
	}
	if call[2] != "managed-prod" {
		t.Errorf("expected 'managed-prod', got %q", call[2])
	}
}

// TestEnsureIpset_ArgvArray verifies ensureIpset passes hash:ip type.
func TestEnsureIpset_ArgvArray(t *testing.T) {
	setupIPSetMock(t)

	if err := ensureIpset("staging"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(capturedIPSetArgs) == 0 {
		t.Fatal("expected ipset call, got none")
	}
	call := capturedIPSetArgs[0]
	if call[1] != "create" {
		t.Errorf("expected 'create', got %q", call[1])
	}
	if call[2] != "managed-staging" {
		t.Errorf("expected 'managed-staging', got %q", call[2])
	}
	if call[3] != "hash:ip" {
		t.Errorf("expected 'hash:ip', got %q", call[3])
	}
}

// TestDestroyIpset_ArgvArray verifies destroyIpset uses correct argv.
func TestDestroyIpset_ArgvArray(t *testing.T) {
	setupIPSetMock(t)

	if err := destroyIpset("staging"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(capturedIPSetArgs) == 0 {
		t.Fatal("expected ipset call, got none")
	}
	call := capturedIPSetArgs[0]
	if call[1] != "destroy" {
		t.Errorf("expected 'destroy', got %q", call[1])
	}
	if call[2] != "managed-staging" {
		t.Errorf("expected 'managed-staging', got %q", call[2])
	}
}

// TestIpsetName verifies the ipset name format.
func TestIpsetName(t *testing.T) {
	cases := []struct {
		env  string
		want string
	}{
		{"prod", "managed-prod"},
		{"staging", "managed-staging"},
		{"my-env-1", "managed-my-env-1"},
	}
	for _, tc := range cases {
		got := ipsetName(tc.env)
		if got != tc.want {
			t.Errorf("ipsetName(%q) = %q, want %q", tc.env, got, tc.want)
		}
	}
}

// TestNoShellInvocation verifies that none of the ipset calls use sh or bash.
func TestNoShellInvocation(t *testing.T) {
	setupIPSetMock(t)

	_ = addManagedMember("prod", "10.0.0.5")
	_ = delManagedMember("prod", "10.0.0.5")
	_ = ensureIpset("prod")
	_ = destroyIpset("prod")

	for _, call := range capturedIPSetArgs {
		if call[0] == "sh" || call[0] == "bash" {
			t.Errorf("shell invocation detected in ipset call: %v", call)
		}
	}
}
