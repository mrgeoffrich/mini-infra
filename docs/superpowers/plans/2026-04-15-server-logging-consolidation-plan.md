# Server Logging Consolidation — Implementation Plan

**Branch:** `logging-consolidation-server` (off main). Single PR target.
**Spec:** `docs/superpowers/specs/2026-04-15-server-logging-consolidation-design.md`.
**Scope:** `server/` only. ~252 files import `logger-factory`. Build lib first (`npm run build:lib`) before tests.

---

## Phase 1 — New infrastructure, coexisting with old

Goal: land the new primitives without breaking any current callers. Old `appLogger()`, `servicesLogger()`, etc. must keep working until Phase 5.

**Files touched:**
- `server/src/lib/logging-context.ts` (new) — `AsyncLocalStorage<{ requestId?; userId?; operationId? }>`; export `runWithContext(ctx, fn)`, `getContext()`, `setUserId(id)`, `setOperationId(id)`. Merge-over-parent semantics.
- `server/src/middleware/request-context.ts` (new) — reads `X-Request-Id` or generates `ulid()`, sets response header, calls `runWithContext({ requestId }, () => next())`. Mirror existing middleware shape in `server/src/middleware/auth.ts`.
- `server/src/lib/logger-factory.ts` — **add** the new API alongside the old:
  - Internal `componentLoggerCache: Map<Component, pino.Logger>` distinct from the legacy `loggerCache`.
  - New `getLogger(component, subcomponent)` overload. Detect 2-arg vs 1-arg via `arguments.length`; keep the old 1-arg signature intact and route it to the legacy cache.
  - New `createComponentRoot(component)` builds pino options from the new config shape (single `logs/app.log` destination, mixin reading `getContext()`). Reuse existing `serializeError`, `getRedactionPaths`, `traceCaller`.
  - Export `LogComponent` string-literal union covering the 12 taxonomy values.
- Keep `appLogger`, `httpLogger`, … exports untouched.

**Patterns to mirror:** existing `traceCaller` proxy and `createBaseLoggerOptions` redaction setup. `ulid` generation already used in `lib/request-id.ts` — reuse the same package.

**Hazards:**
- `request-id.ts` currently populates `req.id`. Keep it mounted for now; the new `request-context` middleware is additive. Remove `request-id.ts` only in Phase 8, once `pino-http` is reading `requestId` from ALS.
- Mixin must be cheap: a single `getContext()` call, conditional spread, return. No allocations for the no-context case.
- `AsyncLocalStorage` import is Node-only — fine for server.

**Commands:** `npm run build:lib && npm run build -w server -- --noEmit` (or `tsc --noEmit` for typecheck).
**Verify:** typecheck clean; existing callers unchanged; new symbols importable.

---

## Phase 2 — Config schema + JSON

**Files touched:**
- `server/src/lib/logging-config.ts` — replace `environmentLogConfigSchema` with a new shape: `{ destination: z.string().nullable(), rotation?: rotationConfigSchema, levels: z.object({ http: levelEnum, auth: levelEnum, db: …, platform: levelEnum }) }`. Regenerate `EnvironmentLogConfig`. Update the in-code fallback to match. Add `getComponentLevel(component)` and `getDestinationConfig()` helpers used by the new factory.
- `server/config/logging.json` — rewrite to the spec's §4 shape. Dev `10m/10`, prod `50m/14`, test `destination: null`. Keep existing `redactionPaths` array verbatim.
- Keep `getLoggerConfig(loggerType)` until Phase 8, returning a synthesized legacy shape derived from the new config (e.g., old `services` → new `platform`'s level). Document the mapping inline.

**Judgement call:** the legacy shim returns `{ level, destination, rotation, prettyPrint: false, includeCaller: true }`. Keep it minimal and well-commented.

**Commands:** typecheck; `npm test -w server -- logging-config`.
**Verify:** Zod parse succeeds against the rewritten JSON in all three envs; old `getLoggerConfig("app")` still returns a valid object.

---

## Phase 3 — Middleware wiring in `app-factory.ts` and boot order in `server.ts`

**Files touched:**
- `server/src/app-factory.ts` — replace `app.use(requestIdMiddleware)` with `app.use(requestContextMiddleware)`. Order: `requestContext` → `pinoHttp` → helmet → cors → json → cookie → `extractJwtUser` → routes. The pino-http `logger` becomes `getLogger("http", "access")`.
- `server/src/lib/jwt-middleware.ts` — after user is resolved, call `setUserId(user.id)`.
- `server/src/server.ts` — add `import { loadLoggingConfig } from "./lib/logging-config"; loadLoggingConfig();` as the **first** import-side-effect line, before `import app`. This guarantees config is parsed before any transitive import constructs a component root.

**Patterns:** mirror `extractJwtUser` wiring for the auth-side `setUserId` call.

**Hazards:**
- `pino-http` must see `requestId` from ALS via the mixin. It will, because `next()` is called synchronously inside `runWithContext`.
- `server.ts` currently calls `clearLoggerCache()` at module top. Keep it but move it below `loadLoggingConfig()`.
- Do NOT remove `request-id.ts` yet (Phase 8); `req.id` may still be read elsewhere.

**Commands:** `npm run build:lib && npm test -w server -- app-factory`.
**Verify:** integration test hitting `/health` with `X-Request-Id: abc` sees `abc` echoed on response and in the access-log line.

---

## Phase 4 — Test mocks support both signatures

**Files touched:** `server/src/__tests__/setup-unit.ts`, `server/src/__tests__/setup-integration.ts`.

Extend the `vi.mock("../lib/logger-factory.ts", …)` factory:
- Keep all existing `appLogger`, `servicesLogger`, …, `agentLogger` exports returning `createMockLogger()`.
- Add a new `getLogger: vi.fn((component: string, subcomponent?: string) => createMockLogger())` that handles both the old 1-arg and new 2-arg forms.
- Add `clearLoggerCache: vi.fn()`, `createChildLogger: vi.fn(() => createMockLogger())`, `serializeError: (e: unknown) => e`.
- Mock `../lib/logging-context.ts`: `runWithContext: (ctx, fn) => fn()`, `getContext: () => ({})`, `setUserId: vi.fn()`, `setOperationId: vi.fn()`.

**Hazard:** many tests call `vi.mocked(getLogger).mock.calls`; the new mock must preserve that. Do not `.mockImplementationOnce` anything here.

**Commands:** `npm test -w server -- --run` (full unit sweep).
**Verify:** suite green with mixed old+new callers.

---

## Phase 5 — Mechanical rewrite of ~252 files

**Strategy:** one commit, grouped logically inside the commit via directory sweep, with a mapping table at the top of `logger-factory.ts` as review anchor. A single commit avoids partial-migration breakage because Phases 1–4 preserved both APIs.

Execute the sweep **by directory batch** (reviewer spot-checks per group), committing nothing between batches — accumulate into one commit at the end:

1. `services/tls/**` → `getLogger("tls", <file-derived>)`
2. `services/haproxy/**` + `services/haproxy/dataplane/**` → `("haproxy", …)`; blue-green files → `("deploy", …)`; `actions/*` judged per-file (see hazards).
3. `services/backup/**`, `services/restore-executor/**` → `("backup", …)`
4. `services/stacks/**`, `services/environment/**` → `("stacks", …)`
5. `services/docker.ts`, `services/docker-executor/**`, `services/container/**`, `services/container-*emitter.ts`, `services/container-log-streamer.ts`, `services/image-inspect.ts`, `services/registry-credential.ts` → `("docker", …)`
6. `services/cloudflare/**`, `services/github-service.ts`, `services/github-app/**` → `("integrations", …)`
7. `services/agent*.ts`, `routes/agent*.ts` → `("agent", …)`
8. Postgres split — `routes/postgres-backups.ts`, `routes/postgres-restore.ts`, `routes/postgres-progress.ts` → `("backup", …)`; everything else postgres → `("db", …)`. `lib/prisma.ts` → `("db", "prisma")`.
9. `routes/auth*.ts`, `lib/jwt*.ts`, `lib/auth*.ts`, `lib/api-key*.ts`, `lib/passport.ts`, `lib/permission*.ts`, `lib/account-lockout-service.ts`, `lib/password-service.ts` → `("auth", …)`
10. `routes/**` (remainder) → `("http", <file-derived>)`
11. Monitoring/platform grab-bag → `("platform", …)`: `services/monitoring/**`, `services/health-check.ts`, `services/circuit-breaker.ts`, `services/connectivity*`, `services/dns/**`, `lib/connectivity-scheduler.ts`, `services/self-update.ts`, `routes/diagnostics.ts`, `routes/self-update.ts`, `routes/monitoring.ts`, `services/application-service-factory.ts`, `services/user-events/**`, `services/user-preferences.ts`, `services/permission-preset-service.ts`, `services/dev-api-key.ts`, `lib/public-url-service.ts`, `lib/error-handler.ts`, `lib/api-logger.ts`, `lib/socket.ts`, `lib/security-config.ts`, `services/agent-sidecar.ts`.

**Rewrite mechanics (per file):**
- Replace `import { xLogger } from "…/logger-factory"` with `import { getLogger } from "…/logger-factory"`.
- Replace module-level `const logger = xLogger();` with `const logger = getLogger("<component>", "<subcomponent>");` where `<subcomponent>` is the kebab-case filename without extension (e.g., `acme-client-manager.ts` → `"acme-client-manager"`). For `index.ts` files, use the parent directory name.
- `createChildLogger("x", ctx)` calls stay working via the shim; do not rewrite them in this pass.

**Judgement-call files (flag in PR description for human review):**
- `services/haproxy/actions/*.ts` — deploy-orchestration (`deploy-application-containers`, `monitor-container-startup`, `enable-traffic`, `disable-traffic`) → `("deploy", …)`; HAProxy primitives (`configure-frontend`, `remove-frontend`, `add-container-to-lb`) → `("haproxy", …)`.
- `services/haproxy/blue-green-*state-machine.ts` → `("deploy", …)`.
- `lib/prisma.ts` — collapse to one `("db", "prisma")`.
- `services/docker.ts` — single `("docker", "docker-service")`.
- `lib/socket.ts` → `("platform", "socket")`.
- `services/progress-tracker.ts` → `("backup", "progress-tracker")`.
- `services/environment/*` → `stacks`.
- `server.ts` → `("platform", "bootstrap")`.

**Commands:** `npm run build:lib && npm test -w server`.
**Verify:** zero TypeScript errors; test suite green; legacy exports still compile (old shim retained until Phase 8).

---

## Phase 6 — console.* → pino in `routes/auth.ts` and `lib/in-memory-queue.ts`

**Files touched:** `server/src/routes/auth.ts` (5 calls, use `getLogger("auth", "auth-routes")`), `server/src/lib/in-memory-queue.ts` (1 call, use `getLogger("platform", "in-memory-queue")`).

**Pattern:** mirror `routes/users.ts` logger usage. Preserve log-line intent; pass error under `err` key for the serializer.

**Hazards:** do NOT touch the `console.log("[STARTUP] …")` calls in `server.ts` — spec §3 keeps them as pre-logger boot chatter.

**Commands:** `npm test -w server -- auth in-memory-queue`.
**Verify:** `grep -n 'console\\.' server/src/routes/auth.ts server/src/lib/in-memory-queue.ts` returns zero hits.

---

## Phase 7 — `runWithContext({ operationId })` at long-running surfaces

Wrap top-level work so logs emitted downstream carry `operationId`. Where an `EventEmitter` is involved, either wrap at emission site (sync) or thread `operationId` through the payload and re-establish scope in the listener (async).

**Files touched (per spec §5):**
- `server/src/services/progress-tracker.ts` — wrap `emit("backup-progress" | "restore-progress" | "operation-completed" | "operation-failed", …)` call sites with `runWithContext({ operationId }, () => emitter.emit(...))`. Add `operationId` to payloads for async consumers.
- `server/src/services/backup/backup-scheduler.ts`, `server/src/services/backup/backup-executor.ts`, `server/src/services/backup/self-backup-executor.ts` — wrap per-operation entry (`runBackup`, `executeBackup`, scheduled-tick handler) in `runWithContext({ operationId: <backup-operation-id> }, fn)`.
- `server/src/services/restore-executor/*` — wrap `restore-runner.ts`'s top-level `run()` and `rollback-manager.ts`'s rollback entry.
- `server/src/services/docker.ts` — in `onContainerChange()` / `onContainerEvent()` callback body, wrap in `runWithContext({ operationId: extractFromLabels(container) }, …)` when the container carries a `mini-infra.operation-id` label. Skip if labels aren't stamped yet — document as follow-up.
- `server/src/services/user-events/user-event-service.ts` — safety wrap around the emit for async consumers.
- Schedulers (each tick wraps in `runWithContext({ operationId: `<scheduler>-<tickId>` }, fn)` using `ulid()`):
  - `server/src/services/tls/certificate-renewal-scheduler.ts`
  - `server/src/services/backup/self-backup-scheduler.ts`
  - `server/src/services/postgres/postgres-database-health-scheduler.ts`
  - `server/src/lib/connectivity-scheduler.ts`
  - `server/src/services/dns/dns-cache-scheduler.ts`
  - `server/src/services/postgres-server/health-scheduler.ts`
  - `server/src/services/user-events/user-event-cleanup-scheduler.ts`
- `server/src/services/stacks/stack-reconciler.ts` — `reconcile()` entry wraps in `runWithContext({ operationId: stackUserEventId ?? ulid() }, fn)`.

**Hazards:**
- Wrapping at the emission site only covers sync listeners. Keep payload threading as belt-and-braces for any listener that does `async`/`setImmediate` work.
- Socket.IO `emitToChannel` is sync, so scope survives — no change required.

**Commands:** `npm test -w server -- progress-tracker backup restore tls-renewal`.
**Verify:** unit test per spec §7 confirms sync listener inherits scope, async listener requires threading.

---

## Phase 8 — Remove legacy factory exports and per-category files

**Files touched:**
- `server/src/lib/logger-factory.ts` — delete `appLogger`, `httpLogger`, `prismaLogger`, `servicesLogger`, `dockerExecutorLogger`, `deploymentLogger`, `loadbalancerLogger`, `selfBackupLogger`, `tlsLogger`, `agentLogger`, `createChildLogger`, default export, the 10-value `loggerType` union, and the legacy `loggerCache`.
- `server/src/lib/logging-config.ts` — delete the legacy-shim `getLoggerConfig(loggerType)` once no callers remain. Confirm via `grep "getLoggerConfig\\b"`.
- `server/src/lib/request-id.ts` — delete the file; remove import from `app-factory.ts`. Confirm no `req.id` readers remain.
- `server/src/__tests__/setup-unit.ts` and `setup-integration.ts` — drop legacy exports from the mock, leaving `getLogger`, `clearLoggerCache`, `createChildLogger`, `serializeError`, plus the `logging-context` mock.
- Verify `logs/app-*.log` files are no longer created by running a boot in dev and listing `server/logs/`.

**Commands:** typecheck; `npm test -w server`; `npm run lint -w server`.
**Verify:** `grep -r "appLogger\\|servicesLogger\\|dockerExecutorLogger\\|deploymentLogger\\|loadbalancerLogger\\|selfBackupLogger\\|tlsLogger\\|agentLogger\\|prismaLogger\\|httpLogger" server/src` returns zero hits. Typecheck clean.

---

## Phase 9 — Tests (unit + integration per spec §7)

**New tests:**
- `server/src/lib/__tests__/logging-context.test.ts` — nested merge, `setUserId`/`setOperationId` isolation.
- `server/src/middleware/__tests__/request-context.test.ts` — header reuse, generation, response header, `getContext()` visible in handler.
- `server/src/lib/__tests__/logger-factory.test.ts` — distinct component instances, independent level mutation, `.child` subcomponent appears in emitted line (use pino's in-memory stream).
- `server/src/lib/__tests__/logger-factory-mixin.test.ts` — mixin adds `requestId`/`userId`/`operationId` when ALS populated; absent when not.
- `server/src/lib/__tests__/logger-factory-als.test.ts` — sync `EventEmitter` listener inherits scope; async listener does not (documents payload-threading rule).
- `server/src/__tests__/logging-http.integration.test.ts` — boot app factory, hit `/health` with `X-Request-Id`, assert access log and downstream log carry same id.
- Smoke assertion in an existing integration test that no log lines emit in test env.

**Patterns:** mirror pino in-memory testing in `server/src/lib/__tests__/connectivity-scheduler.test.ts` — uses `vi.mocked`.

**Commands:** `npm test -w server`.
**Verify:** all new tests green; full suite green; zero log output in test env.

---

## Phase 10 — Docs

**Files touched:**
- `server/README.md` — "Reading logs" section: grep examples from spec §1, `jq` example `tail -f logs/app.log | jq -c '. | {t:.time,c:.component,s:.subcomponent,m:.msg,r:.requestId}'`, note that `npm run dev` no longer pretty-prints — tail the file.
- `server/CLAUDE.md` — append a short "General Rules" item: `getLogger(component, subcomponent)` is the only logger entry-point; list the 12 components.
- `docs/roadmap.md` — mark the logging-consolidation bullet done.

**Verify:** PR preview renders markdown.

---

## Critical files (load-bearing for the whole migration)
- `/Users/geoff/Repos/mini-infra/server/src/lib/logger-factory.ts`
- `/Users/geoff/Repos/mini-infra/server/src/lib/logging-config.ts`
- `/Users/geoff/Repos/mini-infra/server/src/lib/logging-context.ts` (new)
- `/Users/geoff/Repos/mini-infra/server/src/middleware/request-context.ts` (new)
- `/Users/geoff/Repos/mini-infra/server/src/app-factory.ts`
- `/Users/geoff/Repos/mini-infra/server/src/__tests__/setup-unit.ts` and `/Users/geoff/Repos/mini-infra/server/src/__tests__/setup-integration.ts`
- `/Users/geoff/Repos/mini-infra/server/config/logging.json`

## Low-risk bulk-rewrite files
Everything in `server/src/services/tls/**`, `server/src/services/haproxy/dataplane/**`, `server/src/services/backup/**`, `server/src/services/cloudflare/**`, `server/src/services/stacks/**` (excluding `stack-reconciler.ts`), `server/src/routes/**` (excluding `auth.ts`) — pure import + const-declaration swap, no behaviour change.

## Judgement-call files (require human review)
- `/Users/geoff/Repos/mini-infra/server/src/server.ts` (boot order + scheduler wrapping)
- `/Users/geoff/Repos/mini-infra/server/src/lib/prisma.ts` (legacy uses multiple loggers)
- `/Users/geoff/Repos/mini-infra/server/src/services/docker.ts` (event-callback scope propagation)
- `/Users/geoff/Repos/mini-infra/server/src/services/progress-tracker.ts` (EventEmitter scope boundary)
- `/Users/geoff/Repos/mini-infra/server/src/services/stacks/stack-reconciler.ts` (component classification + ALS wrap)
- `/Users/geoff/Repos/mini-infra/server/src/services/haproxy/actions/*.ts` (deploy vs haproxy split)
- `/Users/geoff/Repos/mini-infra/server/src/routes/postgres-*.ts` and `/Users/geoff/Repos/mini-infra/server/src/services/postgres-server/*` (db vs backup split)
- `/Users/geoff/Repos/mini-infra/server/src/lib/jwt-middleware.ts` (auth `setUserId` call site)
