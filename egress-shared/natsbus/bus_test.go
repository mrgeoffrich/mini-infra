package natsbus

import (
	"errors"
	"testing"

	"github.com/nats-io/nats.go"
)

// newTestBus builds a Bus with a stubbed status source so the ConnState state
// machine can be exercised without a live NATS server. `*status` is what the
// SDK's `nc.Status()` would return; flip it to simulate SDK transitions.
func newTestBus(status *nats.Status) *Bus {
	return &Bus{statusFn: func() nats.Status { return *status }}
}

func TestConnState_AuthErrorTransitionsToAuthFailed(t *testing.T) {
	status := nats.DISCONNECTED
	b := newTestBus(&status)

	// Fresh disconnect with no auth error → plain disconnected.
	if got := b.ConnState(); got != ConnStateDisconnected {
		t.Fatalf("initial disconnected: want %q, got %q", ConnStateDisconnected, got)
	}

	// The async ErrorHandler / DisconnectErrHandler records an auth rejection.
	// This is exactly what the SDK does on `nats: authorization violation`.
	b.authFailed.Store(isAuthError(errors.New("nats: authorization violation")))

	if got := b.ConnState(); got != ConnStateAuthFailed {
		t.Fatalf("after auth error (still down): want %q, got %q", ConnStateAuthFailed, got)
	}

	// While still down, RECONNECTING must not mask an outstanding auth failure —
	// the reconnect loop is retrying precisely because auth was rejected.
	status = nats.RECONNECTING
	if got := b.ConnState(); got != ConnStateAuthFailed {
		t.Fatalf("reconnecting while auth-failed: want %q, got %q", ConnStateAuthFailed, got)
	}
}

func TestConnState_CleanReconnectReturnsToConnected(t *testing.T) {
	status := nats.RECONNECTING
	b := newTestBus(&status)
	// Simulate a prior auth rejection.
	b.authFailed.Store(true)
	if got := b.ConnState(); got != ConnStateAuthFailed {
		t.Fatalf("precondition auth-failed: got %q", got)
	}

	// A clean reconnect: the SDK ReconnectHandler clears the flag and the link
	// comes up CONNECTED.
	b.authFailed.Store(false) // what ReconnectHandler does
	status = nats.CONNECTED
	if got := b.ConnState(); got != ConnStateConnected {
		t.Fatalf("after clean reconnect: want %q, got %q", ConnStateConnected, got)
	}
}

func TestConnState_ConnectedClearsStaleAuthFlag(t *testing.T) {
	status := nats.CONNECTED
	b := newTestBus(&status)
	// A stale auth flag left over from an earlier blip must not survive a live
	// CONNECTED status — ConnState clears it as a belt-and-suspenders guard so
	// the agent can't wedge on auth-failed after it has actually recovered.
	b.authFailed.Store(true)
	if got := b.ConnState(); got != ConnStateConnected {
		t.Fatalf("connected with stale flag: want %q, got %q", ConnStateConnected, got)
	}
	if b.authFailed.Load() {
		t.Fatalf("expected ConnState to clear the stale auth flag on CONNECTED")
	}
}

func TestConnState_ReconnectingWithoutAuthError(t *testing.T) {
	status := nats.RECONNECTING
	b := newTestBus(&status)
	if got := b.ConnState(); got != ConnStateReconnecting {
		t.Fatalf("reconnecting (no auth error): want %q, got %q", ConnStateReconnecting, got)
	}
}

func TestConnState_NilBusIsDisconnected(t *testing.T) {
	var b *Bus
	if got := b.ConnState(); got != ConnStateDisconnected {
		t.Fatalf("nil bus: want %q, got %q", ConnStateDisconnected, got)
	}
	// A zero-value Bus (statusFn unset — never connected) is also disconnected.
	if got := (&Bus{}).ConnState(); got != ConnStateDisconnected {
		t.Fatalf("zero-value bus: want %q, got %q", ConnStateDisconnected, got)
	}
}

func TestIsAuthError(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{errors.New("nats: authorization violation"), true},
		{errors.New("nats: authentication expired"), true},
		{errors.New("nats: Authorization Violation"), true}, // case-insensitive
		{errors.New("nats: stale connection"), false},
		{errors.New("read: connection reset by peer"), false},
	}
	for _, c := range cases {
		if got := isAuthError(c.err); got != c.want {
			t.Errorf("isAuthError(%v) = %v, want %v", c.err, got, c.want)
		}
	}
}
