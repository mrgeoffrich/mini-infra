package natsbus

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nats-io/nats.go"
)

// A decorated `.creds` blob body (the shape nats-jwt emits and the shape the
// TS `nats-creds` injector writes into the volume). Single-line JWT + seed so
// splitCredsBody yields them verbatim. The values are dummies — the tests here
// exercise option *wiring*, not signature verification.
const (
	testJWT  = "aaaaa.bbbbb.ccccc"
	testSeed = "SUAFAKEUSERNKEYSEEDVALUE"
)

func decoratedCreds() string {
	return "-----BEGIN NATS USER JWT-----\n" +
		testJWT + "\n" +
		"------END NATS USER JWT------\n" +
		"\n" +
		"************************* IMPORTANT *************************\n" +
		"NKEY Seed printed below can be used to sign and prove identity.\n" +
		"\n" +
		"-----BEGIN USER NKEY SEED-----\n" +
		testSeed + "\n" +
		"------END USER NKEY SEED------\n" +
		"\n" +
		"*************************************************************\n"
}

// resolveCredsOption prefers a CredsFile and wires nats.UserCredentials(path),
// which nats.go re-reads on every (re)connect. Proven here by pointing the
// installed UserJWT callback at a real file and reading the JWT back out.
func TestResolveCredsOption_FilePreferredAndReadsFromDisk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "stack-1.creds")
	if err := os.WriteFile(path, []byte(decoratedCreds()), 0o600); err != nil {
		t.Fatalf("write creds file: %v", err)
	}

	// Both set → the file must win (skew tolerance leans on the file).
	opt, src, err := resolveCredsOption(ConnectOptions{CredsFile: path, Creds: decoratedCreds()})
	if err != nil {
		t.Fatalf("resolveCredsOption: %v", err)
	}
	if src != credsSourceFile {
		t.Fatalf("source: want %q, got %q", credsSourceFile, src)
	}
	if opt == nil {
		t.Fatal("expected a non-nil creds option for a set CredsFile")
	}

	// Apply the option to a bare nats.Options and prove UserCredentials wired a
	// file-reading JWT callback: invoking it reads the JWT out of the file.
	var o nats.Options
	if err := opt(&o); err != nil {
		t.Fatalf("apply option: %v", err)
	}
	if o.UserJWT == nil {
		t.Fatal("expected UserCredentials to install a UserJWT callback")
	}
	gotJWT, err := o.UserJWT()
	if err != nil {
		t.Fatalf("UserJWT callback read failed: %v", err)
	}
	if gotJWT != testJWT {
		t.Fatalf("JWT read from file: want %q, got %q", testJWT, gotJWT)
	}
}

// resolveCredsOption wires UserCredentials to the *given path*. nats.go's
// UserJWT option smoke-tests the file-reading callback when it is applied, and
// the SDK re-invokes that same callback on every (re)connect — so pointing at a
// missing path surfaces an error that names the path, proving the option is
// bound to that exact file (and, by the same callback, re-reads it on reconnect).
func TestResolveCredsOption_FilePathHonoured(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.creds")
	opt, src, err := resolveCredsOption(ConnectOptions{CredsFile: missing})
	if err != nil {
		t.Fatalf("resolveCredsOption should not fail at build time: %v", err)
	}
	if src != credsSourceFile {
		t.Fatalf("source: want %q, got %q", credsSourceFile, src)
	}
	var o nats.Options
	err = opt(&o)
	if err == nil || !strings.Contains(err.Error(), missing) {
		t.Fatalf("expected applying the option to fail referencing %q, got %v", missing, err)
	}
}

// With no CredsFile, resolveCredsOption falls back to the inline Creds blob
// (env/NATS_CREDS path) loaded once via nats.UserJWTAndSeed.
func TestResolveCredsOption_FallsBackToEnvBlob(t *testing.T) {
	opt, src, err := resolveCredsOption(ConnectOptions{Creds: decoratedCreds()})
	if err != nil {
		t.Fatalf("resolveCredsOption: %v", err)
	}
	if src != credsSourceEnv {
		t.Fatalf("source: want %q, got %q", credsSourceEnv, src)
	}
	if opt == nil {
		t.Fatal("expected a non-nil creds option for a set Creds blob")
	}
	var o nats.Options
	if err := opt(&o); err != nil {
		t.Fatalf("apply option: %v", err)
	}
	if o.UserJWT == nil {
		t.Fatal("expected UserJWTAndSeed to install a UserJWT callback")
	}
	gotJWT, err := o.UserJWT()
	if err != nil {
		t.Fatalf("UserJWT callback failed: %v", err)
	}
	if gotJWT != testJWT {
		t.Fatalf("JWT from env blob: want %q, got %q", testJWT, gotJWT)
	}
}

// With neither set, no auth option is produced (no-auth dev NATS still connects).
func TestResolveCredsOption_NoneWhenUnset(t *testing.T) {
	opt, src, err := resolveCredsOption(ConnectOptions{})
	if err != nil {
		t.Fatalf("resolveCredsOption: %v", err)
	}
	if src != credsSourceNone {
		t.Fatalf("source: want %q, got %q", credsSourceNone, src)
	}
	if opt != nil {
		t.Fatal("expected a nil creds option when neither CredsFile nor Creds is set")
	}
}

// A malformed inline Creds blob fails at build time so the caller sees a clear
// parse error rather than a silent no-auth connect.
func TestResolveCredsOption_BadEnvBlobErrors(t *testing.T) {
	_, _, err := resolveCredsOption(ConnectOptions{Creds: "not a creds blob"})
	if err == nil {
		t.Fatal("expected an error for a malformed Creds blob")
	}
}
