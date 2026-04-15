# Server Logging Consolidation — Design

**Status:** Proposed
**Date:** 2026-04-15
**Scope:** `server/` only. `client/`, `update-sidecar/`, and `agent-sidecar/` are out of scope for this increment.
**Related roadmap item:** *Logging consolidation* (see `docs/roadmap.md`).

## Goals

- One canonical way to log from server code.
- A single log file that is easy to grep by subsystem when diagnosing production or dev issues.
- Per-component log levels that can be tuned per environment (dev, test, prod) via configuration loaded at boot.
- Every HTTP-served log line carries a request correlation ID. Long-running operations can inject their own operation ID with the same mechanism.

## Non-goals

- Runtime log-level tuning (no UI, no admin API, no file-watch). Deferred to a later roadmap increment.
- Log shipping or central aggregation.
- Migrating `client/`, `update-sidecar/`, or `agent-sidecar/`. Those will follow as separate passes.
- Redesigning the existing Socket.IO event + task tracker progress model. Logging sits alongside it.

## Current state (summary)

- Pino is already the foundation via `server/src/lib/logger-factory.ts` and `server/src/lib/logging-config.ts`.
- 10 legacy categories: `app`, `http`, `prisma`, `services`, `dockerexecutor`, `deployments`, `loadbalancer`, `self-backup`, `tls`, `agent`. Imported by ~252 files.
- Each category currently writes to its own file (`logs/app-*.log`), rotated daily via `pino-roll` with a `1m` size cap (both dev and prod).
- Per-env levels live in `server/config/logging.json`, validated by Zod.
- `pino-http` is wired in `app-factory.ts` for HTTP access logging on top of the category loggers.
- 161 residual `console.*` calls remain across 9 files. The majority are legitimately pre-logger boot code, scripts, or tests; two files (`routes/auth.ts`, `lib/in-memory-queue.ts`) are the only "real" app-code leakage.

## Design

### 1. Taxonomy

Twelve top-level `component` values replace the existing ten. Each log line also carries a kebab-case `subcomponent` field, set once per file.

| Component       | Covers                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------- |
| `http`          | Express middleware, routes, request/response, rate-limit                                    |
| `auth`          | JWT, API keys, passport/OAuth, account lockout, permission checks                           |
| `db`            | Prisma client, migrations, connection issues                                                |
| `docker`        | `DockerService`, `DockerExecutorService`, image pulls, registry credentials, Docker events  |
| `stacks`        | Stack plan/apply/reconcile, state machine, templates, stack user events                     |
| `deploy`        | Blue/green deployment state machines and container lifecycle during deploys                 |
| `haproxy`       | Dataplane client, frontend/backend management, migration, crash-loop watcher, remediation   |
| `tls`           | ACME, certificate lifecycle, renewal scheduler, distribution, certificate stores            |
| `backup`        | Postgres backup/restore, self-backup, restore executor, schedulers                          |
| `integrations`  | Cloudflare (DNS, tunnels, API), GitHub (service, app)                                       |
| `agent`         | Agent sidecar, agent conversations, agent API key, agent settings                           |
| `platform`      | App bootstrap (post-logger), sockets, schedulers (connectivity, DNS cache), self-update, diagnostics, health checks |

Grep patterns:

```sh
# everything in TLS
grep '"component":"tls"' logs/app.log

# just the ACME client
grep '"subcomponent":"acme-client"' logs/app.log

# one HTTP request end-to-end
grep '"requestId":"01H..."' logs/app.log

# a long-running certificate issuance
grep '"operationId":"cert-issue-42"' logs/app.log
```

### 2. Logger API

```ts
import { getLogger } from "@/lib/logger-factory";

const log = getLogger("tls", "acme-client");
log.info({ orderUrl }, "acme order created");
```

Internals:

- One `pino` root logger per component. This gives each component an independently tunable level.
- The per-file instance is a `.child({ subcomponent })` of the component root. Subcomponent rides on every line as a bound field.
- The existing stack-trace proxy (`caller` file:line injection) stays, unchanged.
- The existing `serializeError` serializer stays, unchanged.
- The existing redaction path list stays, unchanged.
- No backwards-compatible function exports. The old `servicesLogger()`, `dockerExecutorLogger()`, etc. are removed as part of the migration.

Subcomponent convention:

- Kebab-case, derived from filename by default (e.g. `services/tls/acme-client-manager.ts` → `acme-client-manager` or the shorter `acme-client`).
- Stable across the lifetime of the file. When a file is renamed or split, devs update the subcomponent.

### 3. Single log file

- Destination: `logs/app.log`.
- Format: newline-delimited JSON (NDJSON). Every line has `{ time, level, component, subcomponent, caller, msg, ...bindings, ...context }`.
- Rotation via `pino-roll`, daily plus size cap:
  - dev: `maxSize: "10m"`, `maxFiles: 10`
  - prod: `maxSize: "50m"`, `maxFiles: 14`
  - test: no file destination (loggers are silent)
- **No console mirror.** Console output is reserved for pre-logger boot code, scripts, and tests. Operators reading `docker logs mini-infra-server` will still see the boot sequence; everything else lives in `logs/app.log`.

### 4. Configuration

`server/config/logging.json` schema (Zod-validated, loaded at boot by `logging-config.ts`):

```jsonc
{
  "development": {
    "destination": "logs/app.log",
    "rotation": { "enabled": true, "maxSize": "10m", "maxFiles": "10" },
    "levels": {
      "http": "info",
      "auth": "info",
      "db": "info",
      "docker": "debug",
      "stacks": "debug",
      "deploy": "debug",
      "haproxy": "debug",
      "tls": "debug",
      "backup": "info",
      "integrations": "info",
      "agent": "debug",
      "platform": "info"
    }
  },
  "test": {
    "destination": null,
    "levels": { "http": "silent", "auth": "silent", "db": "silent", "docker": "silent", "stacks": "silent", "deploy": "silent", "haproxy": "silent", "tls": "silent", "backup": "silent", "integrations": "silent", "agent": "silent", "platform": "silent" }
  },
  "production": {
    "destination": "logs/app.log",
    "rotation": { "enabled": true, "maxSize": "50m", "maxFiles": "14" },
    "levels": {
      "http": "info",
      "auth": "info",
      "db": "warn",
      "docker": "info",
      "stacks": "info",
      "deploy": "info",
      "haproxy": "info",
      "tls": "info",
      "backup": "info",
      "integrations": "info",
      "agent": "info",
      "platform": "info"
    }
  },
  "redactionPaths": [ /* unchanged from today */ ]
}
```

Behaviours:

- `logging-config.ts` updates its Zod schema to enforce the new twelve-component shape. The `EnvironmentLogConfig` type is regenerated accordingly.
- Config is loaded once at boot. No file-watch, no hot-reload. Changes require a restart.
- No `settings`-service integration, no admin REST endpoint. The roadmap bullet about exposing log levels via settings is explicitly deferred.

### 5. Correlation IDs

Two pieces:

**`server/src/lib/logging-context.ts` (new)**

- Wraps Node's `AsyncLocalStorage`.
- Shape: `{ requestId?: string; userId?: string; operationId?: string }`.
- Exports:
  - `runWithContext(ctx, fn)` — run `fn` inside a new ALS scope merged over any parent scope.
  - `getContext()` — returns current context or `undefined`.
  - `setUserId(id)` / `setOperationId(id)` — mutate the current scope (used by auth middleware, long-running ops).

**`server/src/middleware/request-context.ts` (new)**

- Reads `X-Request-Id` request header, or generates one with `ulid()` when absent.
- Sets `X-Request-Id` on the response.
- Calls `runWithContext({ requestId }, () => next())`.
- Mounted in `app-factory.ts` **before** auth middleware and routes.
- Auth middleware calls `setUserId()` once the user is resolved, so downstream logs carry `userId` too.

**Pino `mixin`**

The base pino logger options include a `mixin` function that reads `getContext()` and returns `{ requestId, userId, operationId }` (dropping undefined keys). Every log line automatically picks these up without any call-site change.

**Long-running operations**

Services that start work outside an HTTP request — e.g. schedulers, the certificate renewal loop, the backup scheduler, stack reconcilers — wrap their top-level work in `runWithContext({ operationId }, fn)`. `operationId` matches the `UserEvent` or task-tracker operation ID where one exists, so log lines for a single operation are trivially grep-able.

**ALS and EventEmitter boundaries**

`AsyncLocalStorage` context propagates through `await`, timers, and microtasks, but **not** across `EventEmitter` boundaries: a listener invoked by `emitter.emit(...)` runs in whatever ALS scope the *caller of `emit`* was in, which may or may not be the scope the listener was registered in. For correlation IDs to survive, every code path that emits progress for a tracked operation must follow one of these two rules:

1. **Wrap at the emission site.** The code calling `emitter.emit()` already runs inside `runWithContext({ operationId }, ...)` — listeners inherit the scope naturally because `emit` is synchronous. This is the default expectation for listeners that run sync.
2. **Thread the ID through the payload.** For async listeners, cross-process hops, or anywhere a listener might execute outside the emitter's scope, include `operationId` in the event payload and re-establish the scope at the top of the listener with `runWithContext({ operationId }, async () => { ... })`.

At-risk surfaces that must follow one of these rules during migration:

- `services/progress-tracker.ts` — emits `backup-progress`, `restore-progress`, `operation-completed`, `operation-failed` via `EventEmitter`.
- `services/backup/backup-scheduler.ts`, `services/backup/backup-executor.ts`, `services/backup/self-backup-executor.ts` — backup/restore emission paths.
- `services/restore-executor/*` — restore progress and rollback paths.
- Docker event callbacks registered via `DockerService.onContainerChange()` / `onContainerEvent()` — invoked outside any request scope; wrap the handler body.
- `services/user-events/user-event-service.ts` — Socket.IO emission for `EVENT_CREATED` / `EVENT_UPDATED`; the scope should already be live at the call site.
- Socket.IO emitter modules (`container-socket-emitter`, `haproxy-socket-emitter`, `connectivity-socket-emitter`, `backup-health-socket-emitter`) — same as above.

Socket.IO `emitToChannel` is a plain function call inside the same process, so scope survives it naturally; the risk is only real `EventEmitter` indirection.

### 6. Migration plan

Delivered as one mechanical PR plus one targeted PR:

1. **Infrastructure PR (this design's main output):**
   - Rewrite `logger-factory.ts` to expose `getLogger(component, subcomponent)` with component-rooted pino instances and subcomponent children.
   - Rewrite `logging-config.ts` schema + defaults to the new twelve-component shape.
   - Rewrite `server/config/logging.json` to the new shape.
   - Add `lib/logging-context.ts` and `middleware/request-context.ts`.
   - In `app-factory.ts`, mount middleware in order: `requestContext` → `pinoHttp` → auth → routes, so access logs and downstream handlers both pick up `requestId` from ALS via the mixin.
   - In `server.ts`, call `loadLoggingConfig()` before any service module import chain that could construct a logger, to avoid falling back to hard-coded defaults from `logging-config.ts`.
   - Update the logger-factory mocks in `server/src/__tests__/setup-unit.ts` and `setup-integration.ts` to match the new `getLogger(component, subcomponent)` signature **in the same commit** that deletes the old exports. Failing to do this will break the full test suite.
   - Mechanically rewrite imports across the ~218 files using a mapping table keyed by directory:
     - `services/tls/*` → `("tls", <filename-derived>)`
     - `services/haproxy/*` and `services/haproxy/dataplane/*` → `("haproxy", <...>)`
     - `services/backup/*`, `services/restore-executor/*` → `("backup", <...>)`
     - `services/stacks/*` → `("stacks", <...>)`
     - `services/docker.ts`, `services/docker-executor/*` → `("docker", <...>)`
     - `services/cloudflare/*`, `services/github*`, `services/github-app/*` → `("integrations", <...>)`
     - `services/agent*`, `routes/agent*` → `("agent", <...>)`
     - `services/postgres*`, `services/postgres-server/*` → `("db", <...>)` for DB-level concerns, `("backup", <...>)` for backup-specific pieces.
     - `routes/*` → `("http", <filename-derived>)` for plain routing, `("auth", <...>)` for auth-adjacent.
     - `lib/jwt*`, `lib/auth*`, `lib/api-key*`, `lib/passport*`, `lib/permission*` → `("auth", <...>)`.
     - `lib/prisma.ts` → `("db", "prisma")`.
     - `services/monitoring/*`, `services/health-check*`, `services/circuit-breaker*`, `services/connectivity*`, `services/dns/*`, `lib/connectivity-scheduler*`, `services/self-update*`, `routes/diagnostics*` → `("platform", <...>)`.
     - `services/environment/*` → `("stacks", <...>)` — the environment manager is part of stack orchestration.
     - `services/container-log-streamer.ts` → `("docker", "container-log-streamer")`. Note this service's *own* application logs (Docker connectivity, stream failures) go through pino; the *container stdout/stderr* it forwards to clients via Socket.IO stays on its existing path and is out of scope here.
     - Deployment state machines (`blue-green-*`, `services/haproxy/actions/*` involved in deploy flows) → `("deploy", <...>)` where the concern is deploy orchestration, `("haproxy", <...>)` where the concern is HAProxy primitives.
   - Delete unused old exports (`appLogger`, `servicesLogger`, etc.) and the legacy mapping.
   - Migrate `routes/auth.ts` (5 calls) and `lib/in-memory-queue.ts` (1 call) from `console.*` to pino.

2. **Follow-ups intentionally deferred:**
   - Agent-sidecar, update-sidecar, client migration.
   - Runtime tuning via settings service.
   - Log shipping.

### 7. Testing

- Unit test `request-context` middleware: generates an id when header absent; reuses header when present; sets `X-Request-Id` on response; exposes `requestId` via `getContext()` inside the handler.
- Unit test `logging-context`: nested `runWithContext` calls merge correctly; `setUserId` / `setOperationId` mutate the current scope only.
- Unit test `logger-factory`: `getLogger(component, subcomponent)` returns distinct instances; each component's root level is independently mutable; `.child` subcomponent binding appears in emitted lines.
- Unit test pino mixin: when ALS context is set, emitted lines include `requestId` / `userId` / `operationId`; when unset, those fields are absent.
- Unit test `pino-http` integration: an HTTP access log line emitted by `pino-http` carries the same `requestId` as the application logs for that request (confirms middleware order is correct).
- Unit test ALS + `EventEmitter`: a listener invoked synchronously from inside `runWithContext` inherits the scope; a listener invoked from outside the scope does **not** — documents the expected behaviour that motivates the payload-threading rule in §5.
- Integration test: boot the app factory, hit a simple endpoint with a known `X-Request-Id`, assert the response header echoes it and that `logs/app.log` (or the test-mode in-memory destination) contains a line tagged with the same `requestId`, the expected `component=http`, and the subcomponent for that route.
- Smoke check that test mode still produces zero log output (all components silent, no file destination).

### 8. Operational notes

- The `logs/` directory is mounted on the Docker host volume and is already backed up by the self-backup workflow. No infra change needed.
- `docker logs mini-infra-server` continues to show the boot sequence and any unexpected `console.*` usage, which remains a useful smell test.
- Anyone running `npm run dev` loses the in-terminal pretty stream. The workflow becomes `tail -f server/logs/app.log | jq -c .` or similar. Documented in the server README as part of the PR.

## Risks and mitigations

- **Large mechanical rename touches 218 files.** Mitigated by keeping the rewrite purely import-level where possible; no behaviour changes in callers. Reviewers can spot-check a few directories and trust the rest.
- **Incorrect component choice in edge cases.** Mitigated by the directory-based mapping table, plus a short `CODEOWNERS`-style comment at the top of `logger-factory.ts` explaining the taxonomy. Errors are cheap to fix later.
- **Loss of per-category log files.** Some operators may currently grep `logs/app-tls.log`. Mitigated by consistent structured fields (`component`, `subcomponent`) and a short "how to grep" note in the server README.
- **ALS mixin overhead.** Pino mixins run per log line. Benchmark shows this is cheap, but we keep the mixin body minimal (single `getContext()` call, spread, return) to avoid regressions.

## Open questions

None blocking implementation. Future work may revisit:

- Whether to surface operator-facing log-level controls via the settings service once the rest lands.
- Whether `docker logs` should get a thin "tail of the file" fallback for environments where volume access is awkward.
