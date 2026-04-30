# Server architecture

The server is a single Node process that owns the Docker socket, talks to the database, drives the HAProxy data plane, and brokers everything else. This document is the orientation guide for backend contributors. It covers the layout, the major subsystems, the cross-cutting patterns you must follow, and the boot sequence.

For repo-wide context, start at the root [ARCHITECTURE.md](../ARCHITECTURE.md). For Claude-facing service rules and exhaustive do/don't tables, see [CLAUDE.md](CLAUDE.md) — this doc summarises and links into it.

## Entry points

When you read the server cold, these are the files to open in order.

- [src/server.ts](src/server.ts) — the process entry. Boots logging, security secrets, Docker, schedulers, sidecars, then attaches Socket.IO and binds the HTTP listener. The full sequence is documented in [Boot sequence](#boot-sequence) below.
- [src/app-factory.ts](src/app-factory.ts) — builds the Express app. The `getRouteDefinitions()` table is the canonical list of every route family and where it mounts. Middleware order, dev-vs-prod static serving, and the route-metadata drift check all live here.
- [src/app.ts](src/app.ts) — re-exports the configured app. Test code can call `createApp({ includeRouteIds, routeOverrides })` to spin up a slice of the app in isolation.
- [src/services/stacks/stack-reconciler.ts](src/services/stacks/stack-reconciler.ts) — the heart of the system. Read this once you understand the boot path; everything orchestration-related routes through here.
- [prisma/schema.prisma](prisma/schema.prisma) — the data model. Skim it to learn the nouns.

## Layout

```
server/
├── prisma/                       schema + migrations (sqlite in dev, postgres in prod)
├── src/
│   ├── server.ts                 process entry — boot sequence
│   ├── app.ts                    re-exports the configured Express app
│   ├── app-factory.ts            wires middleware, mounts routes, returns the app
│   ├── routes/                   HTTP handlers, one file per resource family
│   ├── middleware/               auth, request context, validation, gates
│   ├── services/                 the business logic — see "Subsystem map" below
│   ├── lib/                      cross-cutting utilities (logger, prisma, http, jwt)
│   ├── types/                    server-only type augmentations (e.g. express.d.ts)
│   ├── scripts/                  one-off DB tools
│   ├── test-support/             shared fixtures for vitest
│   └── __tests__/                top-level integration tests
└── public/                       built client bundle (production only, served by Express)
```

Entry chain: [src/server.ts](src/server.ts) → [src/app.ts](src/app.ts) → [src/app-factory.ts](src/app-factory.ts) → `src/routes/*`.

Tests live next to the code they test (`src/services/.../__tests__/`) plus a top-level [src/__tests__/](src/__tests__/) for integration.

Compose templates for the built-in stacks (HAProxy, Postgres, Vault, monitoring, egress, Cloudflare tunnel) are loaded from disk by the stack reconciler — see [src/services/stacks/template-file-loader.ts](src/services/stacks/template-file-loader.ts).

## Subsystem map

Each row is one paragraph of "what this is and where to start reading."

### Docker management — [services/docker.ts](src/services/docker.ts), [services/docker-executor/](src/services/docker-executor/)

`DockerService.getInstance()` is the singleton that wraps dockerode. It holds the connection, streams Docker events, invalidates an in-memory container cache (3s TTL), redacts sensitive labels, and exposes typed callbacks (`onContainerChange`, `onContainerEvent`) used by the socket emitter. `DockerExecutorService` is the layer on top: container lifecycle (`ContainerExecutor`, `LongRunningContainer`), network/volume creation (`InfrastructureManager`), multi-container projects (`ProjectManager`), and authenticated image pulls (`pullImageWithAutoAuth`).

**Invariant:** every Docker API call goes through `DockerService.getInstance()`. `new Dockerode()` does not appear in feature code. Direct dockerode calls bypass the cache, the event stream, the timeout protection, and the sensitive-label redaction.

**Invariant:** image pulls always go through `DockerExecutorService.pullImageWithAutoAuth()`. `docker.pull()` is never called directly. The wrapper handles registry detection, credential lookup, and token refresh — without it, private-registry pulls fail unpredictably.

### Stack orchestration — [services/stacks/](src/services/stacks/)

The heart of the system. [stack-reconciler.ts](src/services/stacks/stack-reconciler.ts) drives plan/apply: it computes a diff between the latest stack definition and the running state, runs the plan through a state machine ([state-machine-runner.ts](src/services/stacks/state-machine-runner.ts) + the per-phase machines in `services/haproxy/`), and updates the applied snapshot on success. [template-engine.ts](src/services/stacks/template-engine.ts) handles parameter substitution; [stack-template-service.ts](src/services/stacks/stack-template-service.ts) owns templates with draft-and-publish versioning; [stack-vault-reconciler.ts](src/services/stacks/stack-vault-reconciler.ts) wires Vault-backed inputs into stack containers; [builtin-stack-sync.ts](src/services/stacks/builtin-stack-sync.ts) is what installs the built-in stacks at boot.

**Invariant:** there is one orchestration code path. Built-in services (HAProxy, Postgres, Vault, monitoring, egress, Cloudflare tunnel) and user-deployed applications all reconcile through this reconciler. Avoid the temptation to add a parallel "system services" layer.

### HAProxy — [services/haproxy/](src/services/haproxy/)

[haproxy-service.ts](src/services/haproxy/haproxy-service.ts) is the lifecycle owner. Live config goes through the HAProxy Data Plane API (HTTP) — [haproxy-dataplane-client.ts](src/services/haproxy/haproxy-dataplane-client.ts) re-exports the modular client in [dataplane/](src/services/haproxy/dataplane/), which is split into a base + per-resource mixins (ACL, backend, frontend, HTTP rules, server, SSL, stats, switching rules). No reload, no downtime. The blue-green and initial/removal deployment state machines (`*-state-machine.ts` in this folder) orchestrate green-deploy → health-check → traffic-switch → drain → remove. Frontend management (Manual vs Shared) splits across [haproxy-frontend-manager.ts](src/services/haproxy/haproxy-frontend-manager.ts) and the per-mode managers in `frontend-manager/`.

### TLS / ACME — [services/tls/](src/services/tls/)

[certificate-lifecycle-manager.ts](src/services/tls/certificate-lifecycle-manager.ts) coordinates issuance and renewal. Underneath: [acme-client-manager.ts](src/services/tls/acme-client-manager.ts) (wraps `@mini-infra/acme`), [dns-challenge-provider.ts](src/services/tls/dns-challenge-provider.ts) (DNS-01 via Cloudflare), [azure-storage-certificate-store.ts](src/services/tls/azure-storage-certificate-store.ts) (cert persistence), [certificate-distributor.ts](src/services/tls/certificate-distributor.ts) (push to HAProxy via the data-plane). [certificate-renewal-scheduler.ts](src/services/tls/certificate-renewal-scheduler.ts) runs on a timer and renews 30 days before expiry.

### Backups — [services/backup/](src/services/backup/), [services/restore-executor/](src/services/restore-executor/)

[backup-scheduler.ts](src/services/backup/backup-scheduler.ts) drives cron; [backup-executor.ts](src/services/backup/backup-executor.ts) launches the `pg-az-backup` container as a one-shot. Self-backups (the Mini Infra DB itself) have parallel scheduler/executor. Restores stream through [services/restore-executor/](src/services/restore-executor/). Long-running progress goes through [services/progress-tracker.ts](src/services/progress-tracker.ts), which is the *only* subsystem still on the database-backed `BackupOperation` / `RestoreOperation` model — everything else uses the unified Socket.IO pattern.

**Invariant:** `ProgressTrackerService` is a historical exception, not a template. New tracked operations use the Socket.IO `*_STARTED` / `*_STEP` / `*_COMPLETED` triplet — see [Long-running operations](#long-running-operations) below.

### Vault — [services/vault/](src/services/vault/)

[vault-services.ts](src/services/vault/vault-services.ts) is the entry point used at boot. [vault-seed.ts](src/services/vault/vault-seed.ts) creates baseline policies. AppRole, KV, policy, admin, and credential injection are split across the `vault-*-service.ts` files. [vault-health-watcher.ts](src/services/vault/vault-health-watcher.ts) handles the unseal loop.

### Egress — [services/egress/](src/services/egress/)

Per-environment egress firewall. [egress-policy-lifecycle.ts](src/services/egress/egress-policy-lifecycle.ts) manages rule sets; [egress-gateway-client.ts](src/services/egress/egress-gateway-client.ts) talks to the gateway container; [fw-agent-transport.ts](src/services/egress/fw-agent-transport.ts) is the host-side firewall agent transport; [egress-rule-pusher.ts](src/services/egress/egress-rule-pusher.ts) and [egress-container-map-pusher.ts](src/services/egress/egress-container-map-pusher.ts) keep state synchronised; [egress-log-ingester.ts](src/services/egress/egress-log-ingester.ts) and [egress-event-pruner.ts](src/services/egress/egress-event-pruner.ts) consume the gateway's traffic feed.

### Agent sidecar — [services/agent-service.ts](src/services/agent-service.ts), [services/agent-sidecar.ts](src/services/agent-sidecar.ts)

`agent-sidecar.ts` owns the container's lifecycle (ensure, remove). `agent-service.ts` is the SSE proxy used by the chat UI; conversations are persisted via [services/agent-conversation-service.ts](src/services/agent-conversation-service.ts).

### Self-update — [services/self-update.ts](src/services/self-update.ts)

Health-check-based rolling update. The server launches the update sidecar, which pulls the new image, runs it as a "candidate", health-checks it, and either swaps containers or rolls back. `cleanupOrphanedSidecars()` and `finalizeLastUpdate()` run at boot to recover from interrupted updates.

### Monitoring & DNS — [services/monitoring/](src/services/monitoring/), [services/dns/](src/services/dns/)

`MonitoringService` runs Prometheus + Grafana as a built-in stack and exposes summary endpoints. The DNS cache scheduler ([services/dns/](src/services/dns/)) periodically refreshes Cloudflare zone data so route lookups don't hit the API on every request.

### Audit events — [services/user-events/](src/services/user-events/)

`UserEventService` is the audit log. Every user-initiated mutation that's worth surfacing emits one. Records carry type, status, progress %, metadata, logs, and duration; updates emit `EVENT_UPDATED` on the `EVENTS` channel.

### Connectivity & socket emitters — [services/container-socket-emitter.ts](src/services/container-socket-emitter.ts), [services/connectivity-socket-emitter.ts](src/services/connectivity-socket-emitter.ts), [services/haproxy-socket-emitter.ts](src/services/haproxy-socket-emitter.ts), [services/backup/backup-health-socket-emitter.ts](src/services/backup/backup-health-socket-emitter.ts), [services/egress/egress-socket-emitter.ts](src/services/egress/egress-socket-emitter.ts), [services/stacks/stack-socket-emitter.ts](src/services/stacks/stack-socket-emitter.ts)

Standalone emitter functions (no class wrappers). Each one queries the DB or computes state and calls `emitToChannel()`. Health calculations are extracted into shared modules so REST routes and emitters reuse them.

**Invariant:** every `emitToChannel()` call is wrapped in try/catch by the caller. Schedulers, executors, and route handlers continue working even if no client is listening or Socket.IO is down. Emission failures must never break the caller.

**Invariant:** all channel and event names come from constants in [lib/types/socket-events.ts](../lib/types/socket-events.ts). `Channel.*` and `ServerEvent.*` are the only acceptable values — raw strings are not allowed.

## Server invariants — digest

Most of these are also stated inline in the subsystem map at the spot they apply. This is the consolidated list.

- **Docker:** all access through `DockerService.getInstance()`; image pulls through `DockerExecutorService.pullImageWithAutoAuth()`.
- **Configuration:** mutations require `userId`. Settings are never env vars — they're database rows served by `ConfigurationServiceFactory`.
- **Real-time:** `Channel.*` and `ServerEvent.*` constants only. Every `emitToChannel()` is wrapped in try/catch.
- **Long-running ops:** `*_STARTED → *_STEP → *_COMPLETED`. `ProgressTrackerService` is grandfathered for backup/restore only.
- **Logging:** one entry point — `getLogger(component, subcomponent)`. Components are a fixed set. `console.*` is reserved for the pre-logger boot path.
- **`pino-http`:** receives options from `buildPinoHttpOptions()`, never a pre-built pino instance. (pino-http bundles its own pino copy with mismatched internal Symbols.)
- **External integrations:** wrapping service class with retries, error mapping, and a `validate()` method. Circuit breakers and backoff at flaky boundaries.
- **Boot:** the HTTP listener is the *last* thing to come up. Every singleton, scheduler, and sidecar runs before the port binds.

## Coding patterns

These are the patterns every contributor must follow. [CLAUDE.md](CLAUDE.md) has the full do/don't tables; this section explains the *why*.

### Singletons and factories

| Service | Why a singleton | Anti-pattern |
|---|---|---|
| `DockerService.getInstance()` | One Docker connection, shared event stream, in-memory cache | `new Dockerode(...)` |
| `DockerExecutorService.getInstance()` | Reuses the Docker connection; image-pull queue and progress tracking | Calling `docker.pull()` directly |
| `ApplicationServiceFactory.getInstance()` | Tracks running app services; supports stop-by-label fallback | Stopping containers by ID outside the factory |

`ConfigurationServiceFactory` ([services/configuration-factory.ts](src/services/configuration-factory.ts)) creates per-category config services (`docker`, `cloudflare`, `azure`, `postgres`, `tls`). Always go through the factory; never `new DockerConfigService()`. Check `factory.isSupported(category)` before creating.

### Image pulls always use `pullImageWithAutoAuth()`

[services/docker-executor/](src/services/docker-executor/) handles registry detection, credential lookup via `RegistryCredentialService`, token refresh (5 minutes before expiry), and progress streaming. Calling `docker.pull()` skips all of that, so image pulls fail unpredictably for private registries.

### Configuration mutations require `userId`

`set()`, `delete()`, and `create()` on every configuration service take a `userId` for the audit trail (`createdBy`, `updatedBy`). If you find yourself wanting to omit it, that's a sign the call is happening outside a request scope where it shouldn't be — propagate `userId` through, or use a system actor constant if it's truly system-driven.

### Socket emission

Standalone functions in `*-socket-emitter.ts` files. The pattern:

```ts
export async function emitConnectivityStatus() {
  try {
    const state = await computeConnectivityState();
    emitToChannel(Channel.CONNECTIVITY, ServerEvent.CONNECTIVITY_STATUS, state);
  } catch (err) {
    log.error({ err }, "failed to emit connectivity status");
  }
}
```

Rules:
1. **Use `Channel.*` and `ServerEvent.*` constants** from [lib/types/socket-events.ts](../lib/types/socket-events.ts). Never raw strings.
2. **Wrap in try/catch.** Emission failures must never break the caller (a scheduler, an executor, a route handler).
3. **Extract shared logic** (e.g. health calculators) into modules that REST routes and emitters both import. Don't duplicate.

### Long-running operations

Every tracked operation emits a triplet:

- `*_STARTED` — once, with `operationId`, `totalSteps`, `stepNames[]`
- `*_STEP` — per step, with `step`, `status` (`completed` | `failed` | `skipped`), `completedCount`, `totalSteps`
- `*_COMPLETED` — once, with `success`, `steps[]`, `errors[]`

The service signature accepts an `onStep` callback rather than emitting directly:

```ts
async issueCertificate(req, onStep?: IssuanceStepCallback) {
  onStep?.({ step: "Create ACME order", status: "completed" }, 1, totalSteps);
}
```

The route handler wires `onStep` to `emitToChannel()`. This keeps services decoupled from Socket.IO and makes them unit-testable.

When adding a new tracked operation:
1. Add channel + `*_STARTED` / `*_STEP` / `*_COMPLETED` constants to [lib/types/socket-events.ts](../lib/types/socket-events.ts).
2. Implement the service with an `onStep` parameter.
3. Wire `onStep` → `emitToChannel()` in the route handler.
4. Register the task type on the client in [client/src/lib/task-type-registry.ts](../client/src/lib/task-type-registry.ts).
5. Optionally create a `UserEvent` record for persistent audit.

[services/progress-tracker.ts](src/services/progress-tracker.ts) is the *exception*: backup and restore use a database-backed progress model with EventEmitter (not Socket.IO). Don't extend it to new operation types — use the Socket.IO pattern.

### Auth and permissions

- JWT extraction lives in [lib/jwt-middleware.ts](src/lib/jwt-middleware.ts); API key validation in [lib/api-key-service.ts](src/lib/api-key-service.ts) and [lib/api-key-middleware.ts](src/lib/api-key-middleware.ts).
- Permission checks go through [lib/permission-middleware.ts](src/lib/permission-middleware.ts). Scopes are `resource:action` strings from [lib/types/permissions.ts](../lib/types/permissions.ts). Presets (Reader/Editor/Admin) are seeded by `seedDefaultPresets()` at boot.
- The internal auth secret used for JWT signing and API-key HMAC is loaded by [lib/security-config.ts](src/lib/security-config.ts) **before any other service initialises** (see boot sequence below). It's never exposed via API, env var, or UI.

### Logging

`getLogger(component, subcomponent)` is the only entry point. One NDJSON file rotated by `pino-roll`. Components are a fixed set: `http`, `auth`, `db`, `docker`, `stacks`, `deploy`, `haproxy`, `tls`, `backup`, `integrations`, `agent`, `platform`. Subcomponent is kebab-case, usually the filename.

Every line carries `component`, `subcomponent`, and (when in scope) `requestId` (from request middleware) or `operationId` (from `withOperation()` / `runWithContext()` in [lib/logging-context.ts](src/lib/logging-context.ts)).

`pino-http` builds its own logger from `buildPinoHttpOptions()` exported by the factory — don't pass it a pre-built pino instance. See [CLAUDE.md](CLAUDE.md) for grep patterns and the per-component levels in `config/logging.json`.

`console.*` is reserved for the pre-logger boot path (`server.ts`, `app-factory.ts`, `prisma.ts`, `config-new.ts`, `logging-config.ts` fallback) and tests/scripts. Don't add new console calls outside those.

### Database

A single Prisma client instance lives in [lib/prisma.ts](src/lib/prisma.ts). Use transactions for multi-step writes that must be atomic. Migrations are created with `prisma migrate dev --name <description>` from the repo root via the `mini-infra-server` filter. The schema lives at [prisma/schema.prisma](prisma/schema.prisma).

### External calls

External boundaries get defensive wrappers, not raw SDK calls:

- **Azure Blob** ([services/azure-storage-service.ts](src/services/azure-storage-service.ts)) — exponential backoff, error mapping (`AuthenticationFailed`, `ENOTFOUND`, etc. → typed codes), 5-minute success cache / 1–2-minute failure cache, metadata sanitisation for Azure's 8 KB key limit.
- **GitHub** ([services/github-service.ts](src/services/github-service.ts)) — circuit breaker (5 failures → 5-minute cooldown), token redaction in logs, 1-second deduplication window.
- **Cloudflare** ([services/cloudflare/](src/services/cloudflare/)) — rate-limit aware, DNS cache feeds via the DNS scheduler.
- **Container registries** — go through `RegistryCredentialService` + `pullImageWithAutoAuth()` (above).

If you're adding a new external service, follow this pattern: a wrapping service class with retries, error mapping, and a `validate()` method that records connectivity status.

### TypeScript discipline

No `any` in new code. Existing `any`s are tech debt to be cleaned up. Prefer narrow types from `@mini-infra/types`; if you need a new shared type, add it to [lib/types/](../lib/types/) and rebuild the types package.

## Cross-cutting concerns

The system-level concerns that don't belong to any single subsystem.

### Cancellation

Long-running operations are not cancellable mid-step today. The reasoning: every step (Docker network create, ACME order, HAProxy server bind) is either fast enough that "wait for it" is acceptable, or has external state that a half-applied cancel would corrupt. If you need to abandon an operation, the right path is to let the step finish and rely on the next reconcile pass to drift back to desired state.

The two places where pre-emptive abort is needed are timeouts and shutdown. Timeouts are handled per-call in the relevant wrapper (`DockerService` adds a 5-second container-lookup timeout; `AzureStorageService` has its own retry/timeout policy). Shutdown is handled by the `gracefulShutdown` handler in [src/server.ts](src/server.ts), which stops schedulers in deterministic order before the process exits — schedulers don't share state, so a single missed iteration on shutdown isn't a correctness problem.

If a future operation genuinely needs cancellation, hook a cancellation token into the `onStep` callback and check it between steps, not within them.

### Testing

Tests live in two places: alongside the code they test (`src/services/<area>/__tests__/`) for unit and per-service integration, and at the top level in [src/__tests__/](src/__tests__/) for cross-service integration. Both use vitest.

**Invariant:** integration tests run against a real database, never a mock. The previous incident the team learned from is mocked tests passing while the production migration broke. The trade-off is that `pnpm build:lib` must run before the test suite, since type imports break if the types package isn't compiled.

`src/test-support/` holds shared fixtures so tests can share the boilerplate of spinning up a Prisma client, a fake Docker, etc.

### Error handling

Three rough categories:

1. **Boundary IO** (Docker, Azure, Vault, Cloudflare, ACME) — the wrapper service catches the SDK error, maps it to a typed code where useful, and either retries (transient) or rethrows (terminal). Boundary errors are the things most likely to break, so they're the things most defended.
2. **Business logic** — throws on unexpected state. Express's `errorHandler` middleware catches and serialises. Don't swallow errors and return a partial result; the route should fail loudly so the client can react.
3. **Background work** (schedulers, emitters, listeners) — wraps every call in try/catch and logs. The principle: a backup that failed yesterday must not stop the scheduler from running today; an emitter with no listener must not bring down the route that triggered it.

`UserEvent` records carry their own `errors[]` for terminal failure detail. The route's response is a summary; the audit log has the full story.

### Observability

The story is structured logs, not metrics. Every line carries `component`, `subcomponent`, and (in scope) `requestId` or `operationId`. The `lib/logging-context.ts` async-local-storage hook propagates context through async boundaries automatically, so a log line emitted three layers down inside a stack apply still ties back to the operation.

Practical recipes (run against `logs/app.*.log` to cover rotation):

```sh
# One HTTP request, end-to-end:
grep -h '"requestId":"<id>"' logs/app.*.log | jq -c .

# One long-running operation, end-to-end:
grep -h '"operationId":"stack-apply-<id>"' logs/app.*.log | jq -c .

# Live tail, projected to the fields that matter:
tail -f $(ls -t logs/app.*.log | head -1) | \
  jq -c '{t:.time, lvl:.level, c:.component, s:.subcomponent, m:.msg, r:.requestId, op:.operationId}'
```

Per-component levels live in `config/logging.json`. There is no runtime log-level UI — change the JSON and restart.

For external-process visibility, the monitoring stack (Prometheus + Grafana, deployed as a built-in stack) is the place to look. Loki ingests the rotated log files.

## Boot sequence

[src/server.ts](src/server.ts) calls `initializeServices()` and then `startServer()` in this exact order. Knowing it matters when adding a new service that depends on another. The HTTP listener is the *last* thing to come up — every scheduler, sidecar, and singleton is already running by the time the first request arrives.

`initializeServices()`:

1. **Logging config** — `loadLoggingConfig()` runs before any service module is imported, so transitive imports build component loggers at the correct level.
2. **Internal auth secret** — `loadOrCreateInternalAuthSecret()` from [lib/security-config.ts](src/lib/security-config.ts). Required before anything that signs JWTs or hashes API keys.
3. **Public URL migration** — one-time migration of a legacy `PUBLIC_URL` env var into the DB.
4. **Docker service** — `DockerService.getInstance().initialize()` connects to the daemon and starts the event stream. A `dockerService.onConnect()` callback re-provisions the agent and fw-agent sidecars after a reconnect (covers the fresh-boot case where the seeder posts the docker host *after* boot).
5. **Container socket emitter** — `setupContainerSocketEmitter()` registers callbacks on `DockerService` so container changes broadcast over Socket.IO.
6. **HAProxy crash-loop watcher** — `setupHAProxyCrashLoopWatcher()` watches for repeated HAProxy crashes and triggers remediation.
7. **Egress fw-agent** — `ensureFwAgent()` provisions the host-singleton firewall agent sidecar before egress background services start, so `EnvFirewallManager` can reach the admin socket on its first reconcile pass.
8. **Egress background services** — `startEgressBackgroundServices()` (rule pushers, log ingester, event pruner).
9. **Self-update cleanup** — `finalizeLastUpdate()` then `cleanupOrphanedSidecars()` recover from interrupted updates.
10. **Agent sidecar** — load Anthropic API key from DB, `initializeAgentApiKey()` (sidecar needs the Mini Infra API key), then `ensureAgentSidecar()`.
11. **Connectivity scheduler** — periodic external-service checks.
12. **Pool instance reaper** — stops idle pool instances on a 60s cadence; force-fails spawns stuck `starting` for >5 min.
13. **Backup scheduler** + **restore executor service** + **PostgreSQL database health scheduler**.
14. **`ApplicationServiceFactory.setDockerService()`** — wires the factory so it can stop containers by label as a fallback.
15. **`syncBuiltinStacks()`** — sync built-in stack definitions (HAProxy, Postgres, Vault, monitoring, egress-gateway, Cloudflare tunnel).
16. **Vault services** — `initVaultServices()` + `seedVaultPolicies()`; if a Vault address is configured, re-authenticate the admin client. `vaultServices.healthWatcher.start()` (no-op when Vault isn't configured).
17. **Builtin vault reconcile** — `runBuiltinVaultReconcile()` when `BUNDLES_DRIVE_BUILTIN=true`.
18. **Monitoring network attach** — connect the server container to the monitoring network so it can proxy to Prometheus / Loki by container name.
19. **Self-backup scheduler**, **user-event cleanup scheduler**, **PostgreSQL server health scheduler**.
20. **TLS renewal scheduler** — only if a certificate blob container is configured. Wires up `AzureStorageCertificateStore` → `AcmeClientManager` → `DnsChallenge01Provider` → `CertificateLifecycleManager` → `CertificateRenewalScheduler`.
21. **DNS cache scheduler** — `DnsCacheService` periodically refreshes Cloudflare zone data.
22. **Permission presets** — `seedDefaultPresets()` ensures Reader/Editor/Admin presets exist.
23. **Development API key** — `initializeDevApiKey()` (only when enabled in dev).
24. **Agent proxy service** — if an Anthropic API key is configured, instantiate `AgentProxyService`.

`startServer()`:

25. **HTTP server** — `createServer(app)` from the configured Express app.
26. **Socket.IO** — `initializeSocketIO(httpServer)` attaches Socket.IO to the same HTTP server with JWT + API-key auth middleware.
27. **`httpServer.listen()`** — bind to the configured port. The `/health` endpoint becomes reachable here.

Adding a new initialisation step belongs in `initializeServices()`. If it depends on Docker, put it after step 4. If it needs Vault, put it after step 17.

## Adding a new feature

A typical end-to-end change touches these things in order:

1. **Schema** — add or modify a model in [prisma/schema.prisma](prisma/schema.prisma). Run `pnpm --filter mini-infra-server exec prisma migrate dev --name <description>` from the repo root.
2. **Types** — add or update shared types in [../lib/types/](../lib/types/). Rebuild with `pnpm build:lib`.
3. **Service** — add the business logic to `src/services/<area>/`. Use existing wrappers (`DockerService`, `DockerExecutorService`, `ConfigurationServiceFactory`, etc.); don't reach for raw SDKs. If it's a new external integration, write a service class that wraps the SDK with retries and error mapping.
4. **Route** — add or extend a file in `src/routes/`. Use `describeRoute` from [lib/describe-route.ts](src/lib/describe-route.ts) to register OpenAPI metadata, validation middleware from [middleware/validation.ts](src/middleware/validation.ts) for input schemas, and permission middleware for scope checks.
5. **Real-time updates** — if state changes belong on a Socket.IO channel, write a `*-socket-emitter.ts` function and call it from the service or route handler. If the operation is long-running, follow the started/step/completed pattern.
6. **Audit** — if it's a user-initiated mutation that should appear in the events page, create a `UserEvent` record via `userEventService.create()`.
7. **Tests** — vitest under `src/__tests__/` (integration) or alongside the service (`<area>/__tests__/`). The shared types package must be built first (`pnpm build:lib`) or test imports fail.
8. **Lint** — `pnpm --filter mini-infra-server lint` before opening a PR.

## Where to next

- [CLAUDE.md](CLAUDE.md) — exhaustive service-pattern do/don't tables, logging grep recipes.
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — repo-wide context.
- [../client/ARCHITECTURE.md](../client/ARCHITECTURE.md) — the other half of the application.
- [../docs/](../docs/) — operator and design docs.
