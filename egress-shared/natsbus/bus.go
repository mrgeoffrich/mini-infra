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
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
)

// DefaultRequestTimeout matches the TS bus default (5 s).
const DefaultRequestTimeout = 5 * time.Second

// ConnState is the out-of-band connection state a bus reports over the agent
// `/healthz` endpoint (§4.2 of the egress NATS credential-resilience plan).
// It is distinct from the in-band KV heartbeat: the heartbeat needs a working
// NATS link to publish, so it can't distinguish "creds rejected" from "still
// starting" — this state can, because it's derived from the SDK's own
// connection callbacks + status rather than from a published message.
type ConnState string

const (
	// ConnStateConnected — the link is up and authenticated.
	ConnStateConnected ConnState = "connected"
	// ConnStateReconnecting — the SDK dropped the link and is retrying, with no
	// evidence the drop was an auth rejection.
	ConnStateReconnecting ConnState = "reconnecting"
	// ConnStateAuthFailed — the link is not up and the last transition carried
	// an authorization/authentication error. This is the signal the 15-hour
	// production incident lacked: an agent whose baked-in creds were orphaned.
	ConnStateAuthFailed ConnState = "auth-failed"
	// ConnStateDisconnected — the link is not up for a non-auth reason (never
	// connected, closed, or a plain network drop).
	ConnStateDisconnected ConnState = "disconnected"
)

// ConnectOptions controls Bus.Connect. NATS_URL/NATS_CREDS are typically
// injected via the stack template's `dynamicEnv` (`nats-url` + `nats-creds`),
// but the call site reads them from the env so a test can override.
type ConnectOptions struct {
	// URL is required (e.g. nats://vault-nats-nats:4222). No default — let the
	// caller decide rather than baking in a wrong URL.
	URL string
	// CredsFile is a path to a `.creds` file on a mounted volume (Phase 5,
	// §4.3). Preferred over Creds when set: nats.go re-reads this file on every
	// (re)connect via nats.UserCredentials, so a rotated credential is picked
	// up without a container recreate. Injected as NATS_CREDS_FILE by the
	// stack template's `nats-creds` dynamicEnv.
	CredsFile string
	// Creds is a `.creds` blob body passed inline (the legacy env-var path,
	// NATS_CREDS). Kept for dev/tests and for image-vs-template version skew:
	// used only when CredsFile is empty. Loaded once via nats.UserJWTAndSeed,
	// so a rotation does NOT reach a Creds-based connection without a recreate.
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

	// authFailed records whether the most recent async/disconnect error the SDK
	// surfaced was an authorization/authentication rejection. Set from the SDK
	// callback goroutines, read from the `/healthz` handler goroutine — hence
	// atomic.Bool, mirroring the gateway's `proxyUp atomic.Bool` listener-health
	// tracking. Cleared on a clean reconnect (or the next time we observe a live
	// CONNECTED status) so a transient auth blip doesn't wedge the reported state.
	authFailed atomic.Bool

	// statusFn returns the SDK's live connection status. In production it is
	// `nc.Status`; tests inject a stub so the ConnState state machine can be
	// exercised without a live NATS server.
	statusFn func() nats.Status

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
	// Build the Bus value up front so the async SDK callbacks below can record
	// connection-state transitions into it (auth-failed detection). `nc`/`js`
	// are filled in once the connect succeeds.
	b := &Bus{
		log:     opts.Logger,
		kvCache: make(map[string]nats.KeyValue),
	}
	natsOpts := []nats.Option{
		nats.Name(name),
		nats.MaxReconnects(maxReconnects),
		nats.ReconnectWait(2 * time.Second),
		nats.PingInterval(20 * time.Second),
		nats.MaxPingsOutstanding(2),
		// Keep retrying through auth failures. By default nats.go aborts the
		// reconnect loop and permanently closes the connection after the server
		// returns the *same* auth error twice in a row — which turns a transient
		// Vault/NATS restart (NATS boots before Vault is unsealed, so it rejects
		// our creds until its accounts load) into a permanent zombie: the proxy
		// keeps running but never receives another container-map/rules push, so
		// its ACL/container map go stale and every request is denied. The
		// sidecars are unattended and must self-heal once NATS comes good, so we
		// opt out of the abort and let MaxReconnects(-1) keep trying.
		nats.IgnoreAuthErrorAbort(),
		// Surface every transition through the structured logger — without
		// these the agent silently flap-loops on a transient NATS bounce.
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			if err != nil {
				// A disconnect carrying an auth error is the re-key hazard: the
				// server rejected our (now-orphaned) creds. Flag it so /healthz
				// reports auth-failed while the reconnect loop keeps trying.
				if isAuthError(err) {
					b.authFailed.Store(true)
				}
				opts.Logger.Warn("nats bus disconnected", "err", err.Error())
			} else {
				opts.Logger.Info("nats bus disconnected (clean)")
			}
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			// A successful reconnect proves the creds are accepted again — clear
			// any auth-failed flag so the reported state returns to connected.
			b.authFailed.Store(false)
			opts.Logger.Info("nats bus reconnected", "url", c.ConnectedUrlRedacted())
		}),
		nats.ClosedHandler(func(_ *nats.Conn) {
			opts.Logger.Warn("nats bus connection closed")
		}),
		nats.ErrorHandler(func(_ *nats.Conn, sub *nats.Subscription, err error) {
			// The async error handler is where `nats: authorization violation`
			// surfaces when the server rejects our creds after the initial
			// connect. Record it for the out-of-band health signal.
			if isAuthError(err) {
				b.authFailed.Store(true)
			}
			subj := ""
			if sub != nil {
				subj = sub.Subject
			}
			opts.Logger.Warn("nats async error", "subject", subj, "err", err.Error())
		}),
	}
	credsOpt, credsSrc, err := resolveCredsOption(opts)
	if err != nil {
		return nil, err
	}
	if credsOpt != nil {
		natsOpts = append(natsOpts, credsOpt)
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
	// `creds source=file` is the Phase 5 Verify-in-prod signal: it proves the
	// agent authenticated from the mounted, reload-on-reconnect creds file
	// rather than the legacy baked-in env credential.
	opts.Logger.Info("nats bus connected", "url", nc.ConnectedUrlRedacted(), "name", name, "creds", string(credsSrc))
	b.nc = nc
	b.js = js
	b.statusFn = nc.Status
	return b, nil
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

// ConnState returns the §4.2 out-of-band connection state, combining the SDK's
// live `nc.Status()` with the auth-failed flag recorded by the async error /
// disconnect callbacks. Goroutine-safe: `statusFn` is the SDK's own
// concurrency-safe status read and `authFailed` is an atomic.
//
//   - CONNECTED                    → connected (and any stale auth flag cleared)
//   - not up + last error was auth → auth-failed
//   - not up + RECONNECTING        → reconnecting
//   - otherwise                    → disconnected
func (b *Bus) ConnState() ConnState {
	if b == nil || b.statusFn == nil {
		return ConnStateDisconnected
	}
	status := b.statusFn()
	if status == nats.CONNECTED {
		// A live connection proves the creds are currently accepted; clear any
		// stale auth flag from a prior blip so we never wedge on auth-failed.
		b.authFailed.Store(false)
		return ConnStateConnected
	}
	// Not up. An auth rejection takes precedence so operators can tell "creds
	// rejected" apart from "still starting / plain network drop".
	if b.authFailed.Load() {
		return ConnStateAuthFailed
	}
	if status == nats.RECONNECTING {
		return ConnStateReconnecting
	}
	return ConnStateDisconnected
}

// isAuthError reports whether err is a NATS authorization/authentication
// rejection. The async ErrorHandler surfaces these as `nats: authorization
// violation` (creds not accepted) or `nats: authentication expired` (a rotated
// account); both must map to auth-failed. Substring matching is used rather
// than sentinel comparison so the classification is resilient to the SDK
// wrapping the error — the async handler often hands us a fresh error built
// from the server's `-ERR` line rather than a wrapped sentinel.
func isAuthError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "authorization") || strings.Contains(msg, "authentication")
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

// credsSource labels how a bus obtained its credentials, surfaced on the
// connect log line as `creds=<source>`. `file` is the Phase 5 target (§4.3):
// nats.go re-reads the file on every reconnect, so a rotation is picked up
// without a container recreate. `env` is the legacy inline-blob path, loaded
// once. `none` is a no-auth (dev) connection.
type credsSource string

const (
	credsSourceNone credsSource = "none"
	credsSourceFile credsSource = "file"
	credsSourceEnv  credsSource = "env"
)

// resolveCredsOption selects the NATS auth option from ConnectOptions,
// preferring a CredsFile (reload-on-reconnect via nats.UserCredentials) over an
// inline Creds blob (loaded once via nats.UserJWTAndSeed). Preferring the file
// and falling back to the env blob makes the bus tolerant of image-vs-template
// version skew: an older template still injecting NATS_CREDS keeps working, and
// a newer template injecting NATS_CREDS_FILE gets live reload. Returns a nil
// option (source "none") when neither is set, so a no-auth dev NATS still
// connects.
func resolveCredsOption(opts ConnectOptions) (nats.Option, credsSource, error) {
	if opts.CredsFile != "" {
		// nats.UserCredentials reads the file lazily inside its JWT/signature
		// callbacks — invoked on the initial connect and on every reconnect —
		// so a rewrite of the file is adopted with no recreate.
		return nats.UserCredentials(opts.CredsFile), credsSourceFile, nil
	}
	if opts.Creds != "" {
		// `UserJWTAndSeed` is the SDK's way to feed a `.creds` body without a
		// file on disk. Splitting into JWT + nkey seed is the same shape
		// `credsAuthenticator` consumes on the TS side. Loaded once — a
		// rotation does not reach this connection without a recreate.
		jwt, seed, err := splitCredsBody(opts.Creds)
		if err != nil {
			return nil, credsSourceNone, fmt.Errorf("natsbus: parse creds: %w", err)
		}
		return nats.UserJWTAndSeed(jwt, seed), credsSourceEnv, nil
	}
	return nil, credsSourceNone, nil
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

// extractArmored pulls the body out of a `-----BEGIN <label>-----` /
// `-----END <label>-----` block.
//
// The dash-count on either side is tolerated as 3-or-more, anchored to a
// line boundary, because the upstream `nats-jwt` formatter (and assorted
// `.creds` files in the wild) emit asymmetric markers: 5 dashes on BEGIN
// but 6 on END. An exact substring match would absorb the extra dash into
// the body and yield e.g. a 59-char nkey seed (legit 58 chars + 1 stray
// `-`), which fails base32 decode at byte 58 — exactly the failure the
// egress-gateway / egress-fw-agent containers were hitting on boot.
//
// Mirrors the regex used by `nats-jwt`'s own `parseCreds`
// (`/[-]{3,}[^\n]*[-]{3,}\n/`).
func extractArmored(body, label string) (string, error) {
	beginRe := regexp.MustCompile(`(?m)^-{3,}\s*BEGIN ` + regexp.QuoteMeta(label) + `\s*-{3,}\s*$`)
	endRe := regexp.MustCompile(`(?m)^-{3,}\s*END ` + regexp.QuoteMeta(label) + `\s*-{3,}\s*$`)
	beginLoc := beginRe.FindStringIndex(body)
	if beginLoc == nil {
		return "", fmt.Errorf("natsbus: missing BEGIN %s marker in creds body", label)
	}
	endLoc := endRe.FindStringIndex(body[beginLoc[1]:])
	if endLoc == nil {
		return "", fmt.Errorf("natsbus: missing END %s marker in creds body", label)
	}
	inner := body[beginLoc[1] : beginLoc[1]+endLoc[0]]
	// Trim per-line whitespace and skip the "***" padding lines the nats-jwt
	// encoder inserts between the JWT block and the seed block.
	out := ""
	for _, line := range splitLines(inner) {
		line = trimSpace(line)
		if line == "" {
			continue
		}
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
