// Package natsbus — Go-side counterpart of `server/src/services/nats/nats-bus.ts`.
//
// One connection per process; all publish/request/subscribe goes through
// `*Bus`. The same DRY rule the TS bus enforces: no raw `nats.Connect()`
// outside this file. Phase 2 lands the egress-fw-agent on this; Phase 3
// will reuse it for the egress-gateway.
//
// Subjects come from `subjects.go`. Payloads come from `payloads.go`. The
// bus deliberately does not embed a Zod-equivalent validator — server-side
// validation is the strict end, and Go's typed structs prevent the
// agent from producing structurally-wrong messages on the publish side.
package natsbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// DefaultRequestTimeout matches the TS bus default (5 s).
const DefaultRequestTimeout = 5 * time.Second

// ConnectOptions controls Bus.Connect. NATS_URL/NATS_CREDS are typically
// injected via the stack template's `dynamicEnv` (`nats-url` + `nats-creds`),
// but the call site reads them from the env so a test can override.
type ConnectOptions struct {
	// URL is required (e.g. nats://vault-nats-nats:4222). No default — let the
	// caller decide rather than baking in a wrong URL.
	URL string
	// CredsFile contents (the body of a `.creds` blob). Optional — useful when
	// connecting to a no-auth dev NATS for round-trip tests.
	Creds string
	// Name shows up in the NATS server's connection list. Defaults to
	// "mini-infra-fw-agent" when empty so log-correlation across the bus
	// works without ceremony.
	Name string
	// Logger is required — the bus emits connect/disconnect/reconnect events
	// through it. Use the shared `egress-shared/log` slog factory at the call
	// site so log lines join cleanly with the agent's other output.
	Logger *slog.Logger
	// MaxReconnects: -1 means unlimited (the bus is meant to keep retrying
	// forever in production). Default unlimited.
	MaxReconnects int
}

// Bus is the singleton chokepoint for system-internal NATS messaging from
// Go. Lifetime spans the process — `Connect` once at boot, `Close` at
// shutdown. The underlying SDK handles reconnect; the bus surfaces the
// transitions through the supplied logger.
type Bus struct {
	nc  *nats.Conn
	js  nats.JetStreamContext
	log *slog.Logger

	// kvCache memoises the JetStream KV handle per bucket. KV resolution is
	// a JS API call (creates the underlying stream if missing); caching it
	// avoids re-doing that on every Put/Get without leaking handles across
	// reconnects (the SDK reuses its underlying conn so the cached handle
	// stays valid as long as `nc` is alive).
	kvMu    sync.RWMutex
	kvCache map[string]nats.KeyValue
}

// Connect establishes the bus connection. Returns the live *Bus or an error.
// Logs (info) on success and (warn) on every reconnect transition the SDK
// surfaces through its callbacks.
func Connect(ctx context.Context, opts ConnectOptions) (*Bus, error) {
	if opts.URL == "" {
		return nil, errors.New("natsbus: ConnectOptions.URL is required")
	}
	if opts.Logger == nil {
		return nil, errors.New("natsbus: ConnectOptions.Logger is required")
	}
	name := opts.Name
	if name == "" {
		name = "mini-infra-fw-agent"
	}
	maxReconnects := opts.MaxReconnects
	if maxReconnects == 0 {
		maxReconnects = -1 // unlimited
	}
	natsOpts := []nats.Option{
		nats.Name(name),
		nats.MaxReconnects(maxReconnects),
		nats.ReconnectWait(2 * time.Second),
		nats.PingInterval(20 * time.Second),
		nats.MaxPingsOutstanding(2),
		// Surface every transition through the structured logger — without
		// these the agent silently flap-loops on a transient NATS bounce.
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			if err != nil {
				opts.Logger.Warn("nats bus disconnected", "err", err.Error())
			} else {
				opts.Logger.Info("nats bus disconnected (clean)")
			}
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			opts.Logger.Info("nats bus reconnected", "url", c.ConnectedUrlRedacted())
		}),
		nats.ClosedHandler(func(_ *nats.Conn) {
			opts.Logger.Warn("nats bus connection closed")
		}),
		nats.ErrorHandler(func(_ *nats.Conn, sub *nats.Subscription, err error) {
			subj := ""
			if sub != nil {
				subj = sub.Subject
			}
			opts.Logger.Warn("nats async error", "subject", subj, "err", err.Error())
		}),
	}
	if opts.Creds != "" {
		// `UserJWTAndSeed` is the SDK's way to feed `.creds` body without a
		// file on disk. Splitting into JWT + nkey seed is the same shape
		// `credsAuthenticator` consumes on the TS side.
		jwt, seed, err := splitCredsBody(opts.Creds)
		if err != nil {
			return nil, fmt.Errorf("natsbus: parse creds: %w", err)
		}
		natsOpts = append(natsOpts, nats.UserJWTAndSeed(jwt, seed))
	}

	// Ensure context cancellation propagates if Connect blocks (e.g. NATS
	// unreachable on boot — caller can pass a timeout context).
	type connectResult struct {
		nc  *nats.Conn
		err error
	}
	resultCh := make(chan connectResult, 1)
	go func() {
		nc, err := nats.Connect(opts.URL, natsOpts...)
		resultCh <- connectResult{nc, err}
	}()
	var nc *nats.Conn
	select {
	case <-ctx.Done():
		// We can't cancel `nats.Connect` mid-flight, but we can fail the
		// caller fast. The goroutine above will resolve eventually; if it
		// connects, we leak a single conn — acceptable for a boot-time
		// timeout that's rare in practice.
		return nil, ctx.Err()
	case r := <-resultCh:
		if r.err != nil {
			return nil, fmt.Errorf("natsbus: connect to %s: %w", opts.URL, r.err)
		}
		nc = r.nc
	}

	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("natsbus: jetstream context: %w", err)
	}
	opts.Logger.Info("nats bus connected", "url", nc.ConnectedUrlRedacted(), "name", name)
	return &Bus{
		nc:      nc,
		js:      js,
		log:     opts.Logger,
		kvCache: make(map[string]nats.KeyValue),
	}, nil
}

// Close drains pending publishes and closes the connection. Idempotent.
func (b *Bus) Close() error {
	if b == nil || b.nc == nil {
		return nil
	}
	if err := b.nc.Drain(); err != nil {
		// Drain returns an error if the conn is already closed — treat as
		// success on second close.
		if errors.Is(err, nats.ErrConnectionClosed) {
			return nil
		}
		return fmt.Errorf("natsbus: drain on close: %w", err)
	}
	return nil
}

// IsConnected reports whether the underlying connection is live. The SDK's
// reconnect loop may briefly flip this to false; callers shouldn't gate
// publishes on it (the SDK buffers up to its `ReconnectBufSize`).
func (b *Bus) IsConnected() bool {
	return b.nc != nil && b.nc.IsConnected()
}

// Publish marshals `payload` to JSON and publishes on `subject`. Returns the
// first error from marshal or publish. No reply expected.
func (b *Bus) Publish(subject string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("natsbus: marshal publish on %s: %w", subject, err)
	}
	if err := b.nc.Publish(subject, data); err != nil {
		return fmt.Errorf("natsbus: publish on %s: %w", subject, err)
	}
	return nil
}

// Request sends a request and decodes the reply into `out`. `timeout` of 0
// applies the bus default (5 s) — same as the TS bus.
func (b *Bus) Request(ctx context.Context, subject string, payload any, out any, timeout time.Duration) error {
	if timeout == 0 {
		timeout = DefaultRequestTimeout
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("natsbus: marshal request on %s: %w", subject, err)
	}
	// `RequestWithContext` honours the supplied context's deadline; we still
	// pass `timeout` via a derived context so the caller's context isn't
	// silently extended by a shorter timeout.
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	msg, err := b.nc.RequestWithContext(reqCtx, subject, data)
	if err != nil {
		return fmt.Errorf("natsbus: request on %s: %w", subject, err)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(msg.Data, out); err != nil {
		return fmt.Errorf("natsbus: unmarshal reply on %s: %w", subject, err)
	}
	return nil
}

// SubscribeHandler is invoked once per delivered message. Returning an error
// is logged but does not unsubscribe — it's a per-message failure, not a
// stream-fatal one. Mirrors the TS bus's "log and continue" stance.
type SubscribeHandler func(msg *nats.Msg) error

// Subscribe attaches a core (non-JetStream) handler. Use for request/reply
// commands (`mini-infra.egress.fw.rules.apply`) — JetStream subscriptions
// go through `Bus.Consume` instead.
func (b *Bus) Subscribe(subject string, handler SubscribeHandler) (*nats.Subscription, error) {
	sub, err := b.nc.Subscribe(subject, func(msg *nats.Msg) {
		if err := handler(msg); err != nil {
			b.log.Error("nats subscribe handler failed", "subject", subject, "err", err.Error())
		}
	})
	if err != nil {
		return nil, fmt.Errorf("natsbus: subscribe on %s: %w", subject, err)
	}
	return sub, nil
}

// Respond is a convenience over Subscribe for request/reply: the handler
// returns a reply payload (or an error) and the bus marshals + responds.
// On handler error, the bus replies with a structured error JSON so callers
// see something concrete instead of a request timeout.
func (b *Bus) Respond(
	subject string,
	handler func(msg *nats.Msg) (reply any, err error),
) (*nats.Subscription, error) {
	return b.Subscribe(subject, func(msg *nats.Msg) error {
		reply, herr := handler(msg)
		if herr != nil {
			// Best-effort error reply. Use the apply-reply shape since
			// every Phase 2+ request subject expects a status/reason
			// envelope; a generic `{ "error": ... }` would diverge from the
			// Zod schema and fail the requester's validation.
			b.log.Warn("nats respond handler error", "subject", subject, "err", herr.Error())
			errBody, _ := json.Marshal(map[string]any{
				"applyId": "", // unknown at this layer; caller can grep logs
				"status":  "rejected",
				"reason":  herr.Error(),
			})
			if msg.Reply != "" {
				_ = b.nc.Publish(msg.Reply, errBody)
			}
			return nil
		}
		if msg.Reply == "" {
			return nil // no reply subject — likely a misuse, but no point erroring per-message
		}
		body, err := json.Marshal(reply)
		if err != nil {
			return fmt.Errorf("marshal reply: %w", err)
		}
		return b.nc.Publish(msg.Reply, body)
	})
}

// splitCredsBody pulls the JWT and nkey seed out of a `.creds` blob.
//
// `.creds` is two `-----BEGIN/END NATS USER JWT-----` and `-----BEGIN/END USER NKEY SEED-----`
// armored blocks. The SDK's `nats.UserCredentials("/path/to.creds")` can
// read this from disk, but we only have it as a string (injected via env
// var by the dynamicEnv pipeline) so we parse it here.
func splitCredsBody(body string) (string, string, error) {
	jwt, err := extractArmored(body, "NATS USER JWT")
	if err != nil {
		return "", "", err
	}
	seed, err := extractArmored(body, "USER NKEY SEED")
	if err != nil {
		return "", "", err
	}
	return jwt, seed, nil
}

func extractArmored(body, label string) (string, error) {
	beginMarker := "-----BEGIN " + label + "-----"
	endMarker := "-----END " + label + "-----"
	start := indexOf(body, beginMarker)
	if start < 0 {
		return "", fmt.Errorf("natsbus: missing %q in creds body", beginMarker)
	}
	rest := body[start+len(beginMarker):]
	end := indexOf(rest, endMarker)
	if end < 0 {
		return "", fmt.Errorf("natsbus: missing %q in creds body", endMarker)
	}
	inner := rest[:end]
	// Trim leading/trailing whitespace and skip the "***" padding lines the
	// nats-jwt encoder inserts around the actual content.
	out := ""
	for _, line := range splitLines(inner) {
		line = trimSpace(line)
		if line == "" {
			continue
		}
		// `.creds` blobs sometimes carry a single line of asterisks as a
		// visual separator. Skip those — they're never part of the payload.
		if isAllAsterisks(line) {
			continue
		}
		out += line
	}
	if out == "" {
		return "", fmt.Errorf("natsbus: empty content for %s in creds body", label)
	}
	return out, nil
}

// Tiny string helpers — avoiding `strings` keeps this file's deps minimal
// and exposes the parsing semantics on one screen.

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}

func isAllAsterisks(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] != '*' {
			return false
		}
	}
	return true
}
