# Internal Messaging — How Mini Infra Components Talk to Each Other

This document is the bird's-eye view of how the moving parts inside a Mini Infra installation communicate. It's the companion to [ARCHITECTURE.md](../../ARCHITECTURE.md) for the cross-process messaging story.

It is hand-maintained. When a transport changes — a sidecar moves onto NATS, a new subject lands, a stream gets a different retention policy — update it.

The migration that produced today's shape is tracked in [docs/planning/not-shipped/internal-nats-messaging-plan.md](../planning/not-shipped/internal-nats-messaging-plan.md). Phases 1–3 have shipped; Phases 4 and 5 are reserved but not implemented. Each phase section below labels what's live and what's stub.

## 1. Scope and non-scope

**In scope:** every system-internal channel between the server and a sidecar or supporting container — egress firewall agent, egress gateway, backups, self-update — plus the smoke-test loopback that proves the bus is alive.

**Out of scope:**

- **Server ↔ client.** Real-time pushes to the browser stay on Socket.IO. Constants live in [lib/types/socket-events.ts](../../lib/types/socket-events.ts). The browser **never** subscribes to NATS directly.
- **Server ↔ Docker daemon.** The server still owns `/var/run/docker.sock` via [server/src/services/docker.ts](../../server/src/services/docker.ts). Sidecars do not dial Docker over NATS — the invariant in [ARCHITECTURE.md](../../ARCHITECTURE.md#external-boundaries) holds.
- **`auth-proxy`.** Synchronous credential brokering on the request path stays HTTP. NATS req/reply would add latency and a second moving part for no benefit.
- **`agent-sidecar`.** A separate solution is in flight there.
- **Application traffic.** Apps deployed by users get their own subject namespace (`app.<stack.id>.>` by default) via the App Roles work. That's a tenant-facing surface, not part of the system control plane this document covers.

## 2. The two real-time fabrics

Two transports, two responsibilities, no overlap.

```
┌──────────┐         Socket.IO          ┌──────────────┐         NATS         ┌────────────────────┐
│  browser │ ◀───── (events, pushes) ── │ Mini Infra   │ ◀── (req/reply,  ──▶ │ sidecars + helper  │
│ (client) │                            │ server       │     events,          │ containers         │
└──────────┘                            │ (Express +   │     heartbeats)      │ (egress-fw-agent,  │
                                        │  Socket.IO)  │                      │  egress-gateway,   │
                                        └──────────────┘                      │  pg-az-backup*,    │
                                                                              │  update-sidecar*)  │
                                                                              └────────────────────┘
                                                * = reserved, not yet on NATS
```

| Fabric | Direction | Use for | Don't use for |
|---|---|---|---|
| Socket.IO | Server → client (mostly) | UI updates, `*_STARTED → *_STEP → *_COMPLETED` triplets, the events page, task tracker progress | System-internal pushes that don't need to reach a browser |
| NATS | Server ↔ sidecars / helper containers | Commands (req/reply), fan-out events, heartbeats, durable replay (JetStream), latest-state caches (KV) | Anything the browser needs to see directly |

The bridge between them is the server. When a NATS event matters to the UI — a backup completed, a firewall rule applied, a gateway decision — the server consumes the NATS message, persists what it needs to (audit log, DB row), and emits a Socket.IO event on the relevant channel. The client subscribes per-room via `useSocketChannel()` and never knows NATS exists.

## 3. The shared `NatsBus`

All publish/subscribe goes through one chokepoint per process. This is the same shape as `DockerService.getInstance()` for the Docker daemon — one connection, one set of guarantees, one place to change the rules.

### 3.1 TypeScript bus

[server/src/services/nats/nats-bus.ts](../../server/src/services/nats/nats-bus.ts)

```ts
class NatsBus {
  static getInstance(opts?): NatsBus
  start(): void                     // fire-and-forget; reconnect loop runs in background
  ready(opts?): Promise<void>        // block until connected
  shutdown(): Promise<void>          // drain in-flight handlers, then close
  getHealth(): BusHealth             // { state, lastConnectedAtMs, lastErrorMessage, url }
  invalidateCreds(): void            // force reconnect after Vault rotation

  publish<T>(subject, payload, opts?): Promise<void>
  request<Req, Res>(subject, payload, opts?): Promise<Res>
  subscribe<T>(subject, handler, opts?): () => void
  respond<Req, Res>(subject, handler, opts?): () => void

  jetstream: {
    ensureStream(spec): Promise<void>
    ensureConsumer(spec): Promise<void>
    publish<T>(subject, payload, opts?): Promise<PubAck>
    consume<T>(spec, handler, opts?): () => void
    ensureKv(spec): Promise<void>
    kv(bucket): BusKv
  }
}
```

Hard rules — these are what keep messages from getting mixed up:

1. **Singleton.** One connection per process. `NatsBus.getInstance()`. No raw `nats.connect()` anywhere else in `server/src`.
2. **Subject constants only.** Every subject string lives in [lib/types/nats-subjects.ts](../../lib/types/nats-subjects.ts). No raw subject strings in service code. Mirrors the `Channel.*` / `ServerEvent.*` rule for Socket.IO.
3. **Typed payloads, validated both ways.** Each subject has a Zod schema in [server/src/services/nats/payload-schemas.ts](../../server/src/services/nats/payload-schemas.ts). The bus validates on **publish and on receive**. Schema mismatch throws — a malformed message never makes it to a handler. Pass `unchecked: true` only for opaque payloads (e.g. NFLOG blobs streaming through a wildcard).
4. **Durable subscriptions.** `subscribe()` and `jetstream.consume()` register the handler in memory; on every reconnect the bus re-attaches them automatically. Callers register once at boot and forget about NATS bounces.
5. **Graceful shutdown.** Every handler Promise is tracked. `shutdown()` waits for in-flight handlers to settle before draining the connection — important for stateful consumers (the egress decisions ingester acks JetStream messages only after the DB write commits).
6. **Logger discipline.** Every publish/subscribe gets `getLogger("integrations", "nats-bus")` context plus the subject and (for req/reply) the inbox correlation id. NDJSON log lines join cleanly with HTTP `requestId` and operation `operationId`.

### 3.2 Go bus

[egress-shared/natsbus/](../../egress-shared/natsbus/)

The two Go sidecars (`egress-fw-agent`, `egress-gateway`) import the same shape from [egress-shared/natsbus/bus.go](../../egress-shared/natsbus/bus.go): `Connect(ctx, opts)`, `Publish`, `Request`, `Subscribe`, `Respond`, `GetKv`, `Close`. JetStream consume is via the native SDK; the bus wrapper handles connection, creds parsing, and reconnect.

Subject constants in [egress-shared/natsbus/subjects.go](../../egress-shared/natsbus/subjects.go) mirror the TS file. They have to stay in lockstep — see §3.4.

### 3.3 What the bus is not

A generic message-broker abstraction. There is no pluggable transport, no retry/DLQ framework, no schema registry, no in-process bus. NATS handles those concerns natively (JetStream for durability, ack/redeliver for retries, work-queue retention for at-least-once delivery). The bus is a thin adapter, not a framework.

### 3.4 Drift control

A CI workflow ([.github/workflows/nats-constants.yml](../../.github/workflows/nats-constants.yml)) runs [scripts/check-nats-subject-drift.mjs](../../scripts/check-nats-subject-drift.mjs) on every PR that touches the constants files or the script itself. It parses both files and fails the build if the subject sets diverge. A code generator is overkill at this scale.

## 4. Subject namespace

All system-internal subjects live under one prefix: **`mini-infra.>`**. Anything else is application traffic.

### 4.1 Shape

```
mini-infra.<subsystem>.<aggregate>.<verb-or-event>[.<id>]
```

| Token | Meaning | Examples |
|---|---|---|
| `mini-infra` | Always. The system namespace. | — |
| `<subsystem>` | The owning area, matches the directory layout where possible. | `system`, `egress`, `backup`, `update` |
| `<aggregate>` | A noun — the thing the subsystem acts on. Optional when the subsystem has only one. | `fw`, `gw`, `cert` |
| `<verb-or-event>` | The discriminator. Verbs and events follow different rules — see §4.2. | `apply`, `applied`, `health`, `events` |
| `<id>` | Optional opaque correlator (env id, run id) when fan-out targets need it. | `01HXYZ…` |

Tokens are kebab-case, all lowercase, no underscores. No wildcards in published subjects — wildcards are subscription-side only.

### 4.2 Three idioms, three rules

The shape of a subject tells you what it is at a glance.

- **Commands** — imperative verb, request/reply.
  Subject ends with the verb: `mini-infra.egress.fw.rules.apply`. Always invoked via `bus.request(...)`. Body is a typed command payload; reply is a typed result. The bus auto-handles `_INBOX.>` plumbing.
- **Events** — past-participle verb, fan-out publish.
  Subject ends with what already happened: `mini-infra.egress.fw.rules.applied`. Published once, may be consumed by zero or more subscribers, JetStream-durable when replay matters. Past tense is a hard rule — if a subscriber sees an event subject they know it's a historical fact.
- **Heartbeats** — the noun, no verb.
  Subject ends with the aggregate alone: `mini-infra.egress.fw.health`. Periodic publish of current state. Stored in a JetStream KV bucket so subscribers can latch the most recent value across server restarts.

### 4.3 Live subject inventory

Everything the codebase actually publishes or subscribes to today:

| Subject | Kind | Shipped in | Storage |
|---|---|---|---|
| `mini-infra.system.ping` | cmd (req/reply) | Phase 1 | core (smoke loopback) |
| `mini-infra.egress.fw.rules.apply` | cmd | Phase 2 | core req/reply |
| `mini-infra.egress.fw.rules.applied` | event | Phase 2 | JetStream `EgressFwEvents` |
| `mini-infra.egress.fw.events` | event (NFLOG) | Phase 2 | JetStream `EgressFwEvents` |
| `mini-infra.egress.fw.health` | heartbeat | Phase 2 | KV `egress-fw-health` |
| `mini-infra.egress.gw.rules.apply.<envId>` | cmd | Phase 3 | core req/reply |
| `mini-infra.egress.gw.rules.applied.<envId>` | event | Phase 3 | core |
| `mini-infra.egress.gw.container-map.apply.<envId>` | cmd | Phase 3 | core req/reply |
| `mini-infra.egress.gw.container-map.applied.<envId>` | event | Phase 3 | core |
| `mini-infra.egress.gw.decisions` | event (proxy decisions) | Phase 3 | JetStream `EgressGwDecisions` (work-queue) |
| `mini-infra.egress.gw.health` | heartbeat | Phase 3 | KV `egress-gw-health` (per-env key) |

Reserved (constants and Go mirrors exist; no producers/consumers yet — see §7):

| Subject | Phase |
|---|---|
| `mini-infra.backup.run`, `.progress.<runId>`, `.completed`, `.failed` | Phase 4 |
| `mini-infra.update.run`, `.progress.<runId>`, `.completed`, `.failed`, `.health-check-passed` | Phase 5 |

### 4.4 JetStream streams, consumers, KV buckets

All ensured idempotently at server boot by [server/src/services/nats/system-nats-bootstrap.ts](../../server/src/services/nats/system-nats-bootstrap.ts) and [server/src/services/nats/nats-system-bootstrap.ts](../../server/src/services/nats/nats-system-bootstrap.ts).

| Resource | Subjects / keys | Retention | Limits |
|---|---|---|---|
| Stream `EgressFwEvents` | `mini-infra.egress.fw.rules.applied`, `.events` | Limits | 1 GiB / 30 d |
| Stream `EgressGwDecisions` | `mini-infra.egress.gw.decisions` | Work-queue | 1 GiB / 30 d |
| Consumer `EgressFwEvents-server` | on `EgressFwEvents` | durable, explicit ack, 30 s ack-wait | maxDeliver 5 |
| Consumer `EgressGwDecisions-server` | on `EgressGwDecisions` | durable, explicit ack | server batch-flushes then acks |
| KV `egress-fw-health` | key `current` | 30 s TTL, 1 revision | 5 s heartbeat → freshness ≤ 10 s = healthy |
| KV `egress-gw-health` | key `<envId>` | 10 min TTL, 1 revision | per-env latest heartbeat |

Names are PascalCase and don't carry the `mini-infra.` prefix — streams/buckets live in their own NATS namespace, so the prefix would be visual noise.

## 5. Per-pair flows

This section walks through every system pair that's currently on the bus. Future phases (backups, self-update) get their sections here when they land.

### 5.1 Server ↔ `egress-fw-agent` — Phase 2 (shipped)

**What was bespoke before:** a Unix socket at `/var/run/mini-infra/fw.sock`, plus a 30 s HTTP health poll, plus a Docker stdout tail for NFLOG events. Three transports per peer, each with its own framing.

**What's on NATS now:**

```
                         mini-infra.egress.fw.rules.apply       (cmd, req/reply)
                              │
   ┌─────────────────┐        ▼            ┌──────────────────┐
   │                 │ ──────────────────▶ │                  │
   │ Mini Infra      │                     │ egress-fw-agent  │
   │ server          │ ◀────────────────── │ (Go sidecar)     │
   │                 │   _INBOX.<auto>     │                  │
   └─────────────────┘   (typed reply)     └──────────────────┘
        ▲   ▲   ▲                                  │   │   │
        │   │   │                                  │   │   │
        │   │   │  mini-infra.egress.fw.rules.applied   │   │
        │   │   └──────────────────────────────────────┘   │
        │   │       (event, JetStream EgressFwEvents)       │
        │   │                                                │
        │   │  mini-infra.egress.fw.events                   │
        │   └────────────────────────────────────────────────┘
        │       (NFLOG stream, JetStream EgressFwEvents)
        │
        │  mini-infra.egress.fw.health
        └─── (5 s heartbeat, KV egress-fw-health)
```

**Server side:**

- [server/src/services/egress/fw-agent-transport.ts](../../server/src/services/egress/fw-agent-transport.ts) — `NatsTransport.envUpsert/envRemove/ipsetAdd/Del/Sync` all call `bus.request(EgressFwSubject.rulesApply, …)` with a discriminated-union `op` field (5 s timeout). Reply Zod-validated by the bus.
- [server/src/services/egress/fw-agent-sidecar.ts](../../server/src/services/egress/fw-agent-sidecar.ts) — health watcher polls the `egress-fw-health` KV bucket every 2 s. Healthy = freshness ≤ 10 s and `ok: true`. The 30 s HTTP poll is gone.
- [server/src/services/egress/egress-log-ingester.ts](../../server/src/services/egress/egress-log-ingester.ts) — durable JetStream consumer `EgressFwEvents-server` ingests both NFLOG events and `rules.applied` confirmations. Manual ack — the bus acks only after the row hits Postgres.

**Agent side ([egress-fw-agent/](../../egress-fw-agent/)):** subscribes to `rules.apply`, publishes `rules.applied` and `events`, publishes a heartbeat to KV every 5 s. The Unix-socket HTTP server is gone.

**Template ([server/templates/egress-fw-agent/template.json](../../server/templates/egress-fw-agent/template.json)):** declares `nats.roles[]` so the apply pipeline mints a credential profile with publish `[rules.applied, events]`, subscribe `[rules.apply]`, and KV access to `egress-fw-health`. `inboxAuto: "reply"` lets the agent reply to requests without an explicit inbox subscription. `NATS_URL` and `NATS_CREDS` are injected via `dynamicEnv`. The Unix-socket bind mount is gone from `volumes[]`.

**Rollback path:** `MINI_INFRA_FW_AGENT_TRANSPORT=unix` re-enables the legacy Unix-socket transport for one release. Both code paths compile. The flag is marked for removal in a follow-up cleanup issue.

### 5.2 Server ↔ `egress-gateway` — Phase 3 (shipped)

**What was bespoke before:** an HTTP admin port at `:8054` for rule and container-map applies, plus a Docker stdout tail for proxy decisions. The log-tail dropped in-flight lines whenever the gateway container restarted.

**What's on NATS now:** same shape as the fw-agent, with one twist — the gateway is per-environment, so commands and applied-events are addressed by appending the environment id:

```
                  mini-infra.egress.gw.rules.apply.<envId>             (per-env cmd)
                  mini-infra.egress.gw.container-map.apply.<envId>     (per-env cmd)
                              │
                              ▼
   ┌─────────────────┐                  ┌──────────────────────────┐
   │ Mini Infra      │ ───────────────▶ │ egress-gateway (envA)    │
   │ server          │ ◀───────────────                              │
   └─────────────────┘                  └──────────────────────────┘
        ▲                                  │
        │  mini-infra.egress.gw.decisions  │  (every proxy decision)
        └─── (shared JetStream EgressGwDecisions, work-queue)
        ▲
        │  mini-infra.egress.gw.health
        └─── (heartbeat, KV egress-gw-health, key=envId)
```

The decisions stream is **shared across all environments** — a single JetStream stream with a server-side durable consumer batches decisions into `EgressEvent` rows in Postgres. Work-queue retention means each decision is delivered once and then dropped from the stream, so a slow gateway can't fill the disk.

**Server side:**

- [server/src/services/egress/egress-gateway-transport.ts](../../server/src/services/egress/egress-gateway-transport.ts) — `pushRulesViaNats(envId, request)` and `pushContainerMapViaNats(envId, request)` build the per-env subject and call `bus.request(...)`. `readGatewayHealth(envId)` reads the latest heartbeat from KV. A malformed heartbeat returns `null` so the UI shows "unknown" rather than throwing.
- [server/src/services/egress/egress-log-ingester.ts](../../server/src/services/egress/egress-log-ingester.ts) — same file as the fw-agent ingester, with a second durable consumer for `EgressGwDecisions`. 60 s in-memory dedup window + batched DB writes (100 rows or 1 s); ack only after `prisma.egressEvent.createMany()` succeeds.

**Gateway side ([egress-gateway/](../../egress-gateway/)):** the per-env credential grants `rules.apply.>` and `container-map.apply.>`, so each gateway picks up only its own env's variant — no broadcast-and-filter at the consumer. The `:8054` admin HTTP listener is gone.

**Template ([server/templates/egress-gateway/template.json](../../server/templates/egress-gateway/template.json)):** declares `nats.roles[]` for the gateway role; `:8054` is no longer exposed.

### 5.3 Server loopback — Phase 1 (shipped)

`mini-infra.system.ping` is the smoke test. The server registers a responder at boot ([server/src/services/nats/nats-bus-ping.ts](../../server/src/services/nats/nats-bus-ping.ts)); `pingSelf(timeoutMs)` sends a request, verifies the nonce round-trip, and returns latency. Proves the connection, the credentials, the JSON codec, the Zod validation, and req/reply plumbing are all working. Exposed via [server/src/routes/nats.ts](../../server/src/routes/nats.ts) for ops triage.

## 6. Bootstrap and credentials

Cold-boot ordering matters: the server publishes to a NATS server (`vault-nats` stack) that the server itself manages.

```
1. Postgres up         ─▶  Prisma client ready
2. Vault services init ─▶  Read NATS server URL + bus creds from Vault KV
3. NATS control plane  ─▶  applyConfig(): refresh operator/account JWTs, render nats.conf,
                            rotate the server-bus creds blob in Vault KV
4. NatsBus.start()     ─▶  Fire-and-forget. Reconnect loop runs in background;
                            non-blocking on a fresh worktree where vault-nats
                            isn't up yet.
5. registerPingResponder() — durable subscription, attaches when the bus
                            first reaches "connected".
6. NatsBus.ready({ 3 s })  — best-effort; on success we run system-resource
                            bootstrap (ensureStream, ensureConsumer, ensureKv).
                            On failure we log and continue — bootstrap retries
                            on next process boot.
7. Bootstrap fw-agent stack (idempotent); the apply pipeline mints the
   `agent` role credential profile and the agent picks up `NATS_URL` +
   `NATS_CREDS` via `dynamicEnv`.
```

[server/src/server.ts](../../server/src/server.ts) is the source of truth.

**Credentials.**

- The server's own bus creds live at `shared/nats-server-bus-creds` in Vault KV. `applyConfig()` rotates them on every run; `NatsBus.invalidateCreds()` triggers a reconnect when they change. The bus reads the latest blob on every connect attempt.
- Agent creds are minted per stack apply by the App Roles pipeline. Each role becomes a `NatsCredentialProfile`; the credential is delivered to the container via the existing `nats-creds` `dynamicEnv` plumbing — same code path as user apps. The fw-agent and egress-gateway templates are just stacks with `nats.roles[]` declared; nothing about the apply pipeline knows they're built-in.

**Reconnect.** Full-jitter exponential backoff between 1 s and 30 s. Retries forever. Durable subscriptions and JetStream consumer registrations are re-attached automatically on every reconnect. A NATS bounce is invisible to subscribers beyond the gap in delivery.

## 7. Observability — how NATS traffic reaches the UI

The browser doesn't subscribe to NATS. Instead, NATS messages that the UI cares about turn into Socket.IO events through the server.

For a long-running operation (today: certificate issuance, stack apply, container connect; future: backups, self-update via Phase 4–5):

```
NATS event                Server consumer                    Socket.IO emission
────────────────────      ─────────────────────────────      ──────────────────────────────
mini-infra.backup.run     bus.subscribe → starts run         CHANNEL.BACKUP, BACKUP_STARTED
mini-infra.backup.        durable consumer →                 BACKUP_STEP (per progress event)
   progress.<runId>        emit per step
mini-infra.backup.        durable consumer → DB row +        BACKUP_COMPLETED
   completed                audit event
```

The server is the bridge. The client sees the same `*_STARTED → *_STEP → *_COMPLETED` triplet it always has. The task tracker in [client/src/components/task-tracker/](../../client/src/components/task-tracker/) doesn't change.

**Logging.** Every bus operation logs to `getLogger("integrations", "nats-bus")` with the subject and inbox correlation id. NDJSON lines join cleanly with HTTP `requestId` and operation `operationId` — one grep on `operationId` shows the full HTTP-to-NATS-to-DB-to-Socket.IO trace.

**Health.** `bus.getHealth()` returns `{ state, lastConnectedAtMs, lastErrorMessage, url }`. The fw-agent and gateway health watchers expose KV-backed peer health to the UI. ConnectivityScheduler integration (so "NATS bus" shows up alongside "Docker", "Vault", etc. in the connected-services list) is a deferred follow-up.

**Metrics.** Publish/subscribe counters and request-latency histograms aren't wired up to a metrics surface yet — log lines carry the same data on a per-call basis until a real consumer lands.

## 8. Adding a new system-internal channel

When a new sidecar or helper container needs to talk to the server, follow the existing pattern instead of inventing a fourth transport.

1. **Pick a subject space** under `mini-infra.<subsystem>.<aggregate>.>` and add the constants to both [lib/types/nats-subjects.ts](../../lib/types/nats-subjects.ts) (TypeScript) and [egress-shared/natsbus/subjects.go](../../egress-shared/natsbus/subjects.go) (Go, only if a Go peer is involved). The CI drift check will fail the PR if they diverge.
2. **Define payload schemas** in [server/src/services/nats/payload-schemas.ts](../../server/src/services/nats/payload-schemas.ts). Register them against the concrete subjects so the bus validates on both ends.
3. **Decide the idiom** — command (req/reply), event (fan-out, JetStream-durable when replay matters), or heartbeat (KV-backed latest-state). Don't mix idioms on one subject.
4. **For events worth replaying**, declare a JetStream stream + durable consumer in `system-nats-bootstrap.ts`. Pick `Limits` retention for history streams, `WorkQueue` for at-least-once delivery to a single server-side consumer.
5. **Declare a NATS role on the template** with the minimum publish/subscribe lists. Add `inboxAuto: "reply"` if the role responds to commands. `NATS_URL` and `NATS_CREDS` are delivered through the existing `dynamicEnv` plumbing — you don't need a custom mechanism.
6. **Server consumer**: `bus.subscribe(...)` or `bus.jetstream.consume(...)` once at boot. Subscriptions are durable across reconnects.
7. **Bridge to Socket.IO** if the UI needs to react. Wrap the emission in try/catch — emission failures must never break the NATS handler. Use `Channel.*` and `ServerEvent.*` constants from [lib/types/socket-events.ts](../../lib/types/socket-events.ts).

## 9. Future surfaces (Phase 4 and 5)

Subjects, schemas (currently `z.unknown()`), and Go constants are reserved. No producers or consumers exist yet. Sections will be filled in here when each phase lands.

### Phase 4 — `pg-az-backup` (planned)

- `mini-infra.backup.run` (cmd, req/reply, fired by the scheduler)
- `mini-infra.backup.progress.<runId>` (event stream, plain pub/sub — short-lived, no replay)
- `mini-infra.backup.completed` / `mini-infra.backup.failed` (events, JetStream `BackupHistory`)

The exit-code path will stay as a fallback so a hard crash mid-run still surfaces as a `failed` event published by the server's container watcher.

### Phase 5 — `update-sidecar` (planned, optional)

- `mini-infra.update.run`, `.progress.<runId>`, `.completed`, `.failed`, `.health-check-passed`

Same shape as Phase 4. Smaller payoff (the sidecar runs to completion in seconds and the existing `docker events` probe works) — landing it just gives us the same `*_STARTED → *_STEP → *_COMPLETED` pattern and lets us delete the bespoke watcher in [server/src/services/self-update.ts](../../server/src/services/self-update.ts).

## 10. Where to next

- [docs/planning/not-shipped/internal-nats-messaging-plan.md](../planning/not-shipped/internal-nats-messaging-plan.md) — the full migration plan (rationale, phase-by-phase deliverables, risks).
- [docs/planning/shipped/nats-app-roles-plan.md](../planning/shipped/nats-app-roles-plan.md) — App Roles, signers, prefix allowlist, cross-stack imports/exports. The substrate this messaging story builds on.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — the system-wide bird's-eye view.
- [server/ARCHITECTURE.md](../../server/ARCHITECTURE.md) — server subsystems and patterns (DockerService, ConfigurationService, etc.).
