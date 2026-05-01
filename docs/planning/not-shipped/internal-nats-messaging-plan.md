# Internal NATS Messaging — Migrating App-to-App Comms onto the Bus

**Status:** planned, not implemented. Phased rollout — each phase is a separate Linear issue.
**Builds on:** the `vault-nats` stack and `NatsControlPlaneService` shipped in #320 / #322, plus the App Roles / Signers / Prefix Allowlist work shipped through #332 (see [shipped/nats-app-roles-plan.md](../shipped/nats-app-roles-plan.md)).
**Excludes:** `agent-sidecar/` — a separate solution is in flight for that surface.

---

## 1. Background

We now run our own NATS server (the managed `vault-nats` stack) with JetStream, account isolation, scoped credentials, and live JWT propagation. Every piece of plumbing needed to use NATS as the spine for system-internal messaging is in place — but none of our own server↔sidecar comms have been moved onto it yet.

Today, server↔sidecar communication is a grab-bag of bespoke transports:

| Pair | Transport | Issues |
|---|---|---|
| server ↔ `egress-fw-agent` | HTTP/1.1 over a Unix socket at `/var/run/mini-infra/fw.sock`, plus Docker log attach for NFLOG, plus 30 s health poll | Three transports per peer; bespoke framing; volume mount; polling |
| server → `egress-gateway` | HTTP REST to admin port `:8054`, plus Docker log attach for proxy decisions | Log-attach is fragile across container restarts and loses messages |
| server → `update-sidecar` | One-shot container, env-vars in, exit code out | Status visibility limited to `docker events` and stdout tail |
| server → `pg-az-backup` | One-shot container, exit code + stdout tail | No live progress; structured result has to be parsed back out of stdout |
| app containers → `auth-proxy` | Synchronous HTTP reverse proxy on the request path | Out of scope — see §6 |

Each transport has its own framing, error handling, retry policy, and observability story. Adding a new sidecar means inventing a fourth one. NATS gives us a single transport with consistent semantics (req/reply, fan-out events, durable JetStream replay) and inherits the credential, audit, and isolation guarantees we already built.

The goal of this plan is to move every system-internal app-to-app channel onto NATS, behind one shared client, with one well-known subject namespace. After it lands, "talking to a sidecar" stops being a transport-design exercise.

## 2. Goals

1. **One shared client.** A single `NatsBus` helper inside `server/` (and a thin Go equivalent for the egress sidecars) — every publish/subscribe goes through it. No raw `nats.connect()` outside the bus.
2. **One namespace, no collisions.** A single `mini-infra` subject prefix, allowlisted once, with a documented sub-tree per subsystem.
3. **Drop a transport per migration.** Each phase removes one bespoke channel (Unix socket, log-attach, health poll, admin-port HTTP) and replaces it with NATS subjects.
4. **Keep the existing observability story.** Long-running operations still emit Socket.IO `*_STARTED → *_STEP → *_COMPLETED` events; NATS just feeds the server, which fans out to the client. The client doesn't subscribe to NATS directly.
5. **Same code path for built-in and user stacks.** The bus injects credentials through the existing `nats-creds` / `nats-url` `dynamicEnv` plumbing — built-in sidecars are just stacks with `natsRole` declared.

## 3. Non-goals

- **Replacing Socket.IO.** Server↔client pushes stay on Socket.IO. Channel/event constants in [`lib/types/socket-events.ts`](../../../lib/types/socket-events.ts) remain the contract for the UI.
- **`auth-proxy` migration.** Synchronous credential brokering on the request path — NATS req/reply adds latency and a second moving part. Stays HTTP. See §6.
- **`agent-sidecar` migration.** Out of scope — separate solution incoming.
- **Replacing the Docker socket.** The server still owns `/var/run/docker.sock`. Sidecars do not start dialing Docker over NATS — the architectural invariant in [ARCHITECTURE.md](../../../ARCHITECTURE.md#external-boundaries) holds.
- **Cross-host NATS.** Single NATS instance on the managed host, same as today. No leaf nodes, no superclusters.

## 4. Subject naming convention

The NATS docs ([nats.io/subjects](https://docs.nats.io/nats-concepts/subjects)) prescribe hierarchy, reserved prefixes (`$SYS`, `$JS`, `$KV`, `_INBOX`), wildcard syntax, ≤16 tokens, ≤256 chars, case sensitivity, and `-`/`_` as delimiters within a token. They do **not** prescribe a verb/tense convention, so we adopt one.

### 4.1 The single system prefix: `mini-infra`

All system-internal subjects live under `mini-infra.>`. Anything else is application traffic and uses `app.<stack.id>.>` (the default), or an admin-allowlisted prefix per the App Roles work.

`mini-infra` is added to the prefix allowlist as part of Phase 1 and bound to system templates only — application templates cannot claim it. The allowlist is the existing `nats-prefix-allowlist` Configuration category; no new mechanism.

### 4.2 The shape

```
mini-infra.<subsystem>.<aggregate>.<verb-or-event>[.<id>]
```

| Token | Meaning | Examples |
|---|---|---|
| `mini-infra` | Always. The system namespace. | — |
| `<subsystem>` | The owning area, matches the directory layout where possible. | `egress`, `backup`, `update`, `tls`, `stacks`, `haproxy` |
| `<aggregate>` | A noun — the thing the subsystem is acting on. Optional if the subsystem has only one aggregate. | `fw`, `gw`, `cert`, `stack` |
| `<verb-or-event>` | The discriminator. Verbs and events follow different rules — see §4.3. | `apply`, `health`, `applied`, `failed` |
| `<id>` | Optional opaque correlator (UUID, stack id, container id) when fan-out targets need it. | `01HXYZ…` |

Tokens are kebab-case (no PascalCase, no underscores). Every segment lowercase. No wildcards in published subjects — wildcards are subscription-side only.

### 4.3 Commands vs events vs heartbeats

Three idioms, one rule each, so a subject's shape tells you what it is.

- **Commands — imperative verb, request/reply.**
  Subject ends with the imperative verb: `mini-infra.egress.fw.rules.apply`, `mini-infra.backup.run`, `mini-infra.update.cancel`.
  Always invoked via NATS request/reply (publisher waits for the responder on the auto-generated `_INBOX.>` subject; the bus handles inbox plumbing). Body is a typed command payload; reply is a typed result.
- **Events — past-participle verb, fan-out publish.**
  Subject ends with what already happened: `mini-infra.egress.fw.rules.applied`, `mini-infra.backup.completed`, `mini-infra.update.health-check-passed`.
  Published once, may be consumed by zero or more subscribers, durable on JetStream when replay matters (backup history, audit). Past-tense is a hard rule — if a subscriber sees an event subject they know it's a historical fact.
- **Heartbeats — the noun, no verb.**
  Subject ends with the aggregate alone: `mini-infra.egress.fw.health`, `mini-infra.update.health`.
  Periodic publish of current state. Subscribers latch the most recent value. Use a JetStream KV bucket if last-known state needs to survive a server restart; otherwise plain pub/sub with a short interval.

### 4.4 Inboxes and JetStream

- **Inboxes** are NATS-native (`_INBOX.>`). The bus auto-injects `_INBOX.>` into every role's subscribe allow list per the existing App Roles `inboxAuto` default. Don't hand-roll reply subjects.
- **JetStream streams** are named after the wildcard they capture, in PascalCase, no `mini-infra.` prefix:
  `EgressFwEvents` captures `mini-infra.egress.fw.>`, `BackupHistory` captures `mini-infra.backup.>.completed` and `.failed`. Stream names have no dots and live in their own NATS namespace, so the prefix would only be visual noise.
- **Consumers** are durable, named `<stream>-<subscriber>` (e.g. `EgressFwEvents-server`, `BackupHistory-events-page`).

### 4.5 Worked example

Egress firewall rule push, end-to-end:

```
Server publishes:    mini-infra.egress.fw.rules.apply       (request, payload = ruleset)
fw-agent replies on: _INBOX.<auto>                          (result = applied | rejected + reason)
fw-agent publishes:  mini-infra.egress.fw.rules.applied     (event, fan-out, JetStream-durable)
fw-agent publishes:  mini-infra.egress.fw.events            (NFLOG stream, JetStream-durable)
fw-agent publishes:  mini-infra.egress.fw.health            (heartbeat, every 5 s)
Server subscribes:   mini-infra.egress.fw.events            (durable consumer EgressFwEvents-server)
                     mini-infra.egress.fw.health            (no consumer; latest-only)
```

Each subject's shape says what it is at a glance — apply/applied is a command/event pair, `events` is a stream of facts, `health` is a heartbeat.

## 5. The shared `NatsBus` (DRY chokepoint)

A single TypeScript module, mirrors the shape of `DockerService.getInstance()`. Lives at `server/src/services/nats/nats-bus.ts`.

```ts
class NatsBus {
  static getInstance(): NatsBus
  publish<T>(subject: string, payload: T): Promise<void>
  request<Req, Res>(subject: string, payload: Req, opts?: { timeoutMs }): Promise<Res>
  subscribe<T>(subject: string, handler: (msg: T, ctx) => Promise<void>): Subscription
  jetstream: {
    ensureStream(spec): Promise<void>
    publish<T>(subject: string, payload: T): Promise<PubAck>
    consume<T>(stream, consumer, handler): Subscription
    kv(bucket): KV
  }
}
```

Hard rules — these are what keep messages from getting mixed up:

1. **Singleton.** One connection per process. The bus owns reconnect/backoff. No service constructs its own `nats.connect()`.
2. **Subject constants.** Every subject is a constant in [`lib/types/nats-subjects.ts`](../../../lib/types/nats-subjects.ts) (new file), grouped by subsystem:
   ```ts
   export const EgressFw = {
     rulesApply: "mini-infra.egress.fw.rules.apply",
     rulesApplied: "mini-infra.egress.fw.rules.applied",
     events: "mini-infra.egress.fw.events",
     health: "mini-infra.egress.fw.health",
   } as const;
   ```
   No raw subject strings anywhere in `server/src`. Mirrors the Socket.IO `Channel.*` / `ServerEvent.*` rule from [ARCHITECTURE.md](../../../ARCHITECTURE.md#cross-cutting-concerns).
3. **Typed payloads.** Each subject has a Zod schema in `lib/types/nats-payloads/<subsystem>.ts`. The bus validates on publish *and* receive. Schema mismatch = thrown error, not a silently-truncated message.
4. **Logger discipline.** Every publish/subscribe carries the existing `getLogger("integrations", "nats-bus")` context plus the subject and (for req/reply) the inbox correlation id. NDJSON lines join cleanly with HTTP `requestId` and operation `operationId`.
5. **Go counterpart.** A small `egress-shared/natsbus` Go package holds the same constants and the same publish/subscribe wrappers, so `egress-fw-agent` and `egress-gateway` use the same shape. Constants live in two places (TS + Go) by necessity — Phase 1 includes a build-time check that they don't drift.

What the bus is **not**: a generic message broker abstraction with pluggable transports, retries, dead-letter queues, or schema registry. NATS handles those concerns natively. The bus is a thin adapter, not a framework.

## 6. Phased rollout

Each phase is a separate Linear issue (linked at the bottom of this doc). Phases land in order — every phase depends on Phase 1 — but later phases are otherwise independent of each other.

### Phase 1 — Foundation: `NatsBus`, subject constants, smoke ping

**Goal:** the shared client, the namespace, and one trivial round-trip working end to end. No production traffic yet.

Deliverables:
- `server/src/services/nats/nats-bus.ts` (singleton, publish/request/subscribe, JetStream wrappers).
- `lib/types/nats-subjects.ts` (subject constants only — runtime-dep-free, per `lib/CLAUDE.md`).
- `server/src/services/nats/payload-schemas.ts` (Zod schemas + inferred types — schemas live server-side because the lib package is types-only).
- `egress-shared/natsbus/` (Go counterpart, constants only — Go client wrappers land in Phase 2 with the first real consumer).
- A `mini-infra-server-bus` `.creds` blob, minted by `applyConfig()` into Vault KV (`shared/nats-server-bus-creds`) and bound to the default account with `pub: ["mini-infra.>"]` + `sub: ["mini-infra.>", "_INBOX.>"]`. Read by `NatsBus` at connect time and rotated on every apply.
- Smoke subject: `mini-infra.system.ping` (request/reply). The server's bus connection registers a loopback responder; a `pingSelf()` helper measures round-trip latency.
- A CI drift check (`scripts/check-nats-subject-drift.mjs`) that fails when the TS and Go subject constants diverge.
- Logger context (`getLogger("integrations", "nats-bus")`).

Deferred to follow-ups (deliberately out of Phase 1 scope):
- **Prefix allowlist entry.** The allowlist gates which *templates* may claim a non-default prefix; the server's own creds carry pub/sub permission directly and don't go through the allowlist. The first template that needs to claim `mini-infra.egress.fw.*` (Phase 2) will add the entry.
- **Connected Service / ConnectivityScheduler integration.** The scheduler is wired around `ConfigurationService.validate()` and adding a fake settings category for the bus is real scope creep. Phase 1 exposes `bus.getHealth()` + `pingSelf()`; UI integration lands as a follow-up.
- **Metrics hooks.** Publish/subscribe counters and request-latency histograms are easy to add but no consumer wires them up yet — log lines carry the same data on a per-call basis until a real metrics surface lands.

Done when: an integration test boots a real `nats:2.12.8-alpine` container, the server bus connects through the testcontainers URL, the loopback ping round-trips with a matching nonce, and Zod validation rejects malformed publishes.

### Phase 2 — `egress-fw-agent` onto NATS

**Goal:** delete the Unix socket, the 30 s health poll, and the Docker log-attach for NFLOG.

Subjects:
- `mini-infra.egress.fw.rules.apply` (cmd, req/reply).
- `mini-infra.egress.fw.rules.applied` (evt, JetStream `EgressFwEvents`).
- `mini-infra.egress.fw.events` (NFLOG stream, JetStream `EgressFwEvents`).
- `mini-infra.egress.fw.health` (heartbeat, 5 s, KV bucket `egress-fw-health`).

Migration shape:
1. fw-agent template gains `nats.roles[]` so it gets `NATS_URL` + `NATS_CREDS` injected.
2. Go agent imports `egress-shared/natsbus`, replaces the HTTP server on the Unix socket with a `subscribe` on `rules.apply`, replaces the stdout-NFLOG with a `publish` on `events`, replaces the on-demand health endpoint with a heartbeat publisher.
3. Server-side: [`fw-agent-transport.ts`](../../../server/src/services/egress/fw-agent-transport.ts) becomes a thin wrapper over `NatsBus.request(EgressFw.rulesApply, …)`; [`fw-agent-sidecar.ts`](../../../server/src/services/egress/fw-agent-sidecar.ts) loses its 30 s poll, replaced by reading the latest `health` heartbeat from the KV bucket.
4. The Unix socket mount comes off the fw-agent stack template.
5. Old transport stays compiled for one release behind a feature flag for rollback; flag is removed in the follow-up clean-up issue.

Done when: a fresh worktree boots without a Unix socket on the fw-agent stack, rule applies succeed via NATS, health UI reflects heartbeat freshness, NFLOG ingester reads from JetStream.

### Phase 3 — `egress-gateway` onto NATS

**Goal:** delete the `:8054` admin HTTP listener and the canonical-decisions log-tail.

Subjects:
- `mini-infra.egress.gw.rules.apply` (cmd, req/reply).
- `mini-infra.egress.gw.rules.applied` (evt).
- `mini-infra.egress.gw.decisions` (every proxy decision; JetStream `EgressGwDecisions`, work-queue retention bounded by size and age).
- `mini-infra.egress.gw.health` (heartbeat).

Migration shape mirrors Phase 2. The Go gateway imports the same `natsbus` helper; `egress-log-ingester.ts` switches from `docker logs` follow to a JetStream durable consumer. Acceptance criterion is the same: the admin port comes off the template and decisions survive a gateway container restart (today they don't — log-attach drops in-flight lines).

### Phase 4 — `pg-az-backup` progress + result events

**Goal:** make backup runs first-class on the bus and free the server from parsing stdout.

Subjects:
- `mini-infra.backup.run` (cmd, req/reply, fired by the scheduler).
- `mini-infra.backup.progress.<runId>` (evt stream, plain pub/sub — short-lived, no replay needed).
- `mini-infra.backup.completed` (evt, JetStream `BackupHistory`).
- `mini-infra.backup.failed` (evt, JetStream `BackupHistory`).

The exit-code path stays as a fallback so a hard crash mid-run still surfaces as a failed event published by the server's container watcher. The in-memory job queue inside [`backup-executor.ts`](../../../server/src/services/backup/backup-executor.ts) becomes a NATS request flight; concurrency stays at two, enforced by the executor, not by NATS.

Done when: backup progress steps appear live in the events page (Socket.IO fan-out from a server subscription on `progress.>`); `BackupHistory` stream replays the last N runs into the events list on cold load.

### Phase 5 — `update-sidecar` progress (optional)

**Goal:** harmonise self-update status with the rest of the bus.

Smaller payoff than Phase 4 — the sidecar runs to completion in seconds and the existing `docker events` probe works. Worth doing only because it lets us delete the bespoke watcher in [`server/src/services/self-update.ts`](../../../server/src/services/self-update.ts) and reuse the same `*_STARTED → *_STEP → *_COMPLETED` pattern as backups.

Subjects:
- `mini-infra.update.run` (cmd, req/reply).
- `mini-infra.update.progress.<runId>` (evt).
- `mini-infra.update.completed` (evt, JetStream `UpdateHistory`).
- `mini-infra.update.failed` (evt).
- `mini-infra.update.health-check-passed` (evt — for the swap-then-validate flow).

Defer until Phase 4 has settled — same pattern, same subscribers; no surprise.

## 7. Risks & open questions

- **Bootstrap ordering.** The server publishes onto a NATS server that the server itself manages (the `vault-nats` stack). On a cold start, the bus must tolerate NATS being unavailable for the first few seconds without crashing the boot sequence. The existing `Connected Service` retry pattern should cover this — verify in Phase 1.
- **Constants drift between TS and Go.** `lib/types/nats-subjects.ts` and `egress-shared/natsbus/subjects.go` need to stay in lockstep. Phase 1 adds a CI check that diffs the parsed constants — a generator is overkill at this scale.
- **JetStream storage budget.** `BackupHistory`, `EgressFwEvents`, `EgressGwDecisions` need explicit byte/age limits in the stream spec. Default to `max-bytes: 1 GiB` and `max-age: 30 d`; revisit when we have real data.
- **Authorization ergonomics.** Each system subsystem becomes a `natsRole` on `vault-nats` (or its own built-in stack). Three roles is fine; if we end up with ten, revisit consolidation.
- **Schema evolution.** Zod schemas are versioned by adding optional fields. Renaming or removing a field requires a new subject token (`v2`), not a schema flag — easier to grep, harder to footgun.
- **Replacing Unix socket is a behaviour change.** Some operators may have monitoring on the socket file. Document the removal in the release notes for the Phase 2 release.

## 8. Linear tracking

Phase issues in Linear (Altitude Devops team) — each links back to this doc. Phase 1 blocks all later phases; Phase 5 also blocks on Phase 4.

- [ALT-26](https://linear.app/altitude-devops/issue/ALT-26) — Phase 1: Foundation (`NatsBus`, subject constants, prefix allowlist)
- [ALT-27](https://linear.app/altitude-devops/issue/ALT-27) — Phase 2: `egress-fw-agent` onto NATS
- [ALT-28](https://linear.app/altitude-devops/issue/ALT-28) — Phase 3: `egress-gateway` onto NATS
- [ALT-29](https://linear.app/altitude-devops/issue/ALT-29) — Phase 4: `pg-az-backup` progress + result events
- [ALT-30](https://linear.app/altitude-devops/issue/ALT-30) — Phase 5: `update-sidecar` progress (optional)
