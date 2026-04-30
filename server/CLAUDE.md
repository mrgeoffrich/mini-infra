# Server — Service Patterns & Coding Conventions

This document describes the service layer patterns that **must** be followed when writing server-side code. Using raw SDK/library calls instead of these wrappers will bypass caching, authentication, error handling, circuit breakers, and audit logging.

## DockerService (`services/docker.ts`)

The singleton gateway to the Docker daemon. All Docker API access goes through here.

```ts
const docker = DockerService.getInstance();
```

| Do this | Not this | Why |
|---------|----------|-----|
| `DockerService.getInstance()` | `new Dockerode(...)` | Singleton manages connection, events, caching |
| `docker.listContainers()` | `dockerode.listContainers()` | Wrapper caches results (3s TTL), deduplicates ports, redacts secrets |
| `docker.getContainer(id)` | `dockerode.getContainer(id)` | Wrapper adds timeout protection (5s) and 404 handling |
| `docker.isConnected()` check first | Calling methods blind | Methods throw "Docker service not connected" if not initialized |

Key behaviors:
- **Must call `initialize()` before any operations** — this connects to the daemon and starts the event stream
- **Event-driven cache invalidation** — listens to Docker events (start, stop, die, etc.) and invalidates automatically
- **Sensitive label redaction** — labels containing `password`, `token`, `secret`, `key`, `credential` are masked in output
- **Register callbacks** via `onContainerChange()` / `onContainerEvent()` for real-time Socket.IO updates — don't poll

## DockerExecutorService (`services/docker-executor/`)

Manages container lifecycle operations: pulling images, creating/running containers, executing commands.

```ts
const executor = DockerExecutorService.getInstance();
```

### Image Pulls — Always Authenticated

| Do this | Not this | Why |
|---------|----------|-----|
| `executor.pullImageWithAutoAuth(image)` | `docker.pull(image)` | Auto-resolves registry credentials, handles token refresh |
| `executor.pullImageWithAuth(image, user, pass)` | Manual `authconfig` construction | Proper error handling, timeout, progress tracking |

`pullImageWithAutoAuth()` does the following automatically:
1. Extracts the registry URL from the image name (e.g., `ghcr.io/owner/repo` → `ghcr.io`)
2. Looks up stored credentials via `RegistryCredentialService`
3. Refreshes tokens that expire within 5 minutes
4. Falls back to default credential if no exact registry match
5. Handles pull progress stream with timeout protection

### Container Operations

- Use `ContainerExecutor` for running one-shot containers (backups, migrations)
- Use `LongRunningContainer` for services that stay up
- Use `InfrastructureManager` for network/volume creation
- Use `ProjectManager` for multi-container project operations (stacks)

## RegistryCredentialService (`services/registry-credential.ts`)

Manages Docker registry credentials with encrypted storage.

| Do this | Not this | Why |
|---------|----------|-----|
| `registryCredService.getCredentialsForImage(imageName)` | Hardcoding auth or reading DB directly | Handles registry URL extraction, decryption, token refresh |
| Let the service encrypt via `createCredential()` | Storing plaintext passwords | Passwords are AES-encrypted using API key secret |
| `registryCredService.validateCredential(id)` | Manual Docker login attempts | Uses fast manifest check, handles all registry types |

Key behaviors:
- **Automatic registry detection** from image names — maps unqualified images to Docker Hub
- **Token refresh** — registered refreshers auto-renew tokens 5 minutes before expiry
- **Default credential fallback** — if no exact registry match, uses the configured default

## ConfigurationService (`services/configuration-base.ts`)

Abstract base class for all settings services. All settings are stored in the database with audit tracking.

| Do this | Not this | Why |
|---------|----------|-----|
| `service.get(key)` — handle `null` return | Assuming empty string for missing keys | Returns `null` when key not found |
| Always pass `userId` to `set()` / `delete()` | Omitting userId | All mutations are audited (createdBy, updatedBy) |
| Use `ConfigurationServiceFactory.create()` | `new DockerConfigService()` | Factory ensures proper initialization |
| Call `validate()` | Manually pinging services | `validate()` records connectivity status, captures metadata |

### ConfigurationServiceFactory (`services/configuration-factory.ts`)

Supported categories: `"docker"`, `"cloudflare"`, `"azure"`, `"postgres"`, `"tls"`

```ts
const factory = new ConfigurationServiceFactory();
const dockerConfig = factory.create({ category: "docker" });
```

Always check `factory.isSupported(category)` before creating.

## AzureStorageService (`services/azure-storage-service.ts`)

Wraps `@azure/storage-blob` with retry logic, caching, and error mapping.

| Do this | Not this | Why |
|---------|----------|-----|
| `azureService.listBackupFiles(container, prefix)` | Raw `BlobServiceClient` calls | Wrapper adds retry with exponential backoff, timeout, error mapping |
| `azureService.testContainerAccess(name)` | Repeated manual checks | Results cached for 5 minutes (1-2 min on failure) |
| `azureService.generateBlobSasUrl(container, blob)` | Manual SAS token construction | Handles account name extraction, default 15-min expiry |
| `azureService.setConnectionString(connStr, userId)` | Raw DB update | Validates format (requires `DefaultEndpointsProtocol`, `AccountName`, `AccountKey`) |

Key behaviors:
- **Retry with backoff** — retries transient failures, skips retries on auth errors
- **Error mapping** — `AuthenticationFailed`, `InvalidAccountKey`, `ENOTFOUND`, `Rate exceeded` → specific error codes
- **Metadata sanitization** — invalid key chars replaced with `_`, values truncated to 8KB per Azure limits

## GitHubService (`services/github-service.ts`)

Wraps Octokit with circuit breaker pattern.

| Do this | Not this | Why |
|---------|----------|-----|
| `githubService.createIssue(request)` | `octokit.rest.issues.create()` | Circuit breaker fails fast after 5 consecutive failures, 5-min cooldown |
| `githubService.validate()` | `octokit.rest.users.getAuthenticated()` | Validates both user auth AND repository access |
| `githubService.getConfigStatus()` | Reading config keys individually | Returns structured status with `isConfigured` flag |

Key behaviors:
- **Circuit breaker** — after 5 failures, all subsequent calls fail fast for 5 minutes
- **Token redaction** — `gh*_` patterns and sensitive keys are redacted in logs
- **Deduplication window** (1 second) — prevents thundering herd on API failures

## ApplicationServiceFactory (`services/application-service-factory.ts`)

Manages lifecycle of application services (HAProxy, monitoring, etc.).

```ts
const factory = ApplicationServiceFactory.getInstance();
```

| Do this | Not this | Why |
|---------|----------|-----|
| `factory.createService(options)` then `factory.startService(name)` | Creating and starting in one step | Creation only instantiates; start is separate |
| `factory.stopService(name)` | Stopping containers directly | Factory has fallback: finds containers by label if service not registered |
| Call `setDockerService()` first | Using factory without Docker service | Needed for fallback container stopping by label match |

Key behaviors:
- Labels used for container matching: `mini-infra.environment`, `mini-infra.service`
- `destroyAllServices()` for clean shutdown
- Returns `false`/`undefined` for missing services instead of throwing

## Stack Container Manager (`services/stacks/`)

For multi-container stack deployments.

| Do this | Not this | Why |
|---------|----------|-----|
| `containerManager.pullImage(image, tag)` | `docker.pull(image + ":" + tag)` | Delegates to `pullImageWithAutoAuth` with proper formatting |
| Use `StackReconciler` for updates | Manual container replacement | Reconciler diffs desired vs actual state, handles force-pull digest comparison |

## Long-Running Operation Progress

All long-running operations follow a layered progress tracking system. When adding a new operation, use these classes — don't build ad-hoc progress reporting.

### Socket.IO Event Pattern (primary real-time feedback)

Every tracked operation emits three events following the **started → step → completed** pattern:

```ts
// STARTED — emitted once when operation begins
emitToChannel(Channel.TLS, ServerEvent.CERT_ISSUANCE_STARTED, {
  operationId, totalSteps, stepNames: string[]
});

// STEP — emitted per major step
emitToChannel(Channel.TLS, ServerEvent.CERT_ISSUANCE_STEP, {
  operationId,
  step: { step: string, status: 'completed' | 'failed' | 'skipped', detail?: string },
  completedCount, totalSteps
});

// COMPLETED — emitted once when operation finishes
emitToChannel(Channel.TLS, ServerEvent.CERT_ISSUANCE_COMPLETED, {
  operationId, success: boolean, steps: OperationStep[], errors: string[]
});
```

Event constants are defined in `lib/types/socket-events.ts` — add new ones there.

### Step Callback Pattern

Services accept an `onStep` callback rather than emitting socket events directly. The caller wires the callback to `emitToChannel()`:

```ts
// In the service:
async issueCertificate(request, onStep?: IssuanceStepCallback) {
  // ... do work ...
  onStep?.({ step: 'Create ACME order', status: 'completed' }, 1, totalSteps);
}

// In the route handler:
await certManager.issueCertificate(request, (step, count, total) => {
  emitToChannel(Channel.TLS, ServerEvent.CERT_ISSUANCE_STEP, {
    operationId, step, completedCount: count, totalSteps: total
  });
});
```

Always wrap `onStep` calls in try/catch so progress failures never break the operation.

### UserEventService (`services/user-events/`)

General-purpose audit/event log for all user-initiated operations. Use this for persistent operation history.

| Do this | Not this | Why |
|---------|----------|-----|
| `userEventService.create({ eventType, status, ... })` | Custom DB inserts | Tracks status, progress %, metadata, logs, duration, and emits Socket.IO events |
| `userEventService.update(id, { status, progress })` | Direct Prisma updates | Auto-calculates `durationMs` on completion, emits `EVENT_UPDATED` |

Emits `EVENT_CREATED` / `EVENT_UPDATED` on the `EVENTS` channel automatically.

### ProgressTrackerService (`services/progress-tracker.ts`)

Database-backed progress tracking for **backup and restore operations only**. Do not use for other operation types.

- Persists `BackupOperation` / `RestoreOperation` records with step metadata
- Uses `EventEmitter` (not Socket.IO) — emits `backup-progress`, `restore-progress`, `operation-completed`, `operation-failed`
- Auto-cleans old records: 7 days for completed, 30 days for failed
- Repairs stale "running" operations stuck > 1 hour

### Adding a New Tracked Operation

1. Add event constants to `lib/types/socket-events.ts` (channel + started/step/completed events)
2. Implement the service with an `onStep` callback parameter
3. Wire `onStep` → `emitToChannel()` in the route handler
4. Register the task type in the frontend task type registry (see `client/CLAUDE.md`)
5. Optionally create a `UserEvent` record for audit trail

## Logging (`lib/logger-factory.ts`)

One entry point per file. All log lines land in a **single NDJSON file**; `pino-roll` rotates it daily + on size cap to `logs/app.<N>.log` (highest `<N>` is newest — dev 10m/10 files, prod 50m/14 files).

```ts
import { getLogger } from "@/lib/logger-factory";
const log = getLogger("tls", "acme-client-manager");
log.info({ orderUrl }, "acme order created");
```

Components (`component` field): `http`, `auth`, `db`, `docker`, `stacks`, `deploy`, `haproxy`, `tls`, `backup`, `integrations`, `agent`, `platform`. The `subcomponent` is kebab-case, usually the filename without extension.

Every log line carries `component`, `subcomponent`, and — when inside a request scope — `requestId` (+ `userId` once auth resolves). Long-running ops opt in by wrapping top-level work in `runWithContext({ operationId }, fn)` or `withOperation("<prefix>", fn)` from `lib/logging-context.ts`; `operationId` then rides on every downstream line emitted during that scope.

`pino-http` builds its own logger from `buildPinoHttpOptions("http", "access")` (exported from the factory) — **don't** pass a pre-built pino logger to pino-http, because pino-http ships its own nested pino copy whose internal Symbols don't match the server's. Hand it options, not an instance.

Grep patterns (run against `logs/app.*.log` to cover rotation):

```sh
grep -h '"component":"tls"' logs/app.*.log | jq -c .
grep -h '"subcomponent":"acme-client-manager"' logs/app.*.log | jq -c .
grep -h '"requestId":"<id>"' logs/app.*.log | jq -c .          # one HTTP request end-to-end
grep -h '"operationId":"stack-apply-<id>"' logs/app.*.log | jq -c .  # one long-running op end-to-end
tail -f $(ls -t logs/app.*.log | head -1) | jq -c '{t:.time, lvl:.level, c:.component, s:.subcomponent, m:.msg, r:.requestId, op:.operationId}'
```

Per-component levels live in `config/logging.json` under `development` / `production` / `test`, loaded at boot. No runtime tuning, no UI, no hot reload — change the JSON and restart the process.

Console output is reserved for pre-logger boot (`server.ts`, `app-factory.ts`, `prisma.ts`, `config-new.ts`, `logging-config.ts` fallback) plus scripts and tests. Don't add new `console.*` calls outside those sites.

## Test Conventions

### Field-persistence regression tests must go through the HTTP route

If you're testing that a field set on a request body lands on the correct DB column, write the test against the HTTP route via **supertest** — do NOT seed the DB with `prisma.<model>.create({ data: {...} })` and assert what comes back.

**Why:** Mini Infra hit a real bug where `services[].vaultAppRoleRef` was silently stripped by Zod's default unknown-key behaviour at the HTTP boundary. Existing integration tests for the apply pipeline wrote rows directly via `testPrisma.stackTemplateService.create({...})` — those tests passed because they bypassed the validation layer entirely. The field never made it from a real POST body to the DB column, but no test caught that the public API surface was broken.

```ts
// ❌ Tests the apply orchestrator, NOT the HTTP contract.
//    Will pass even if the route's Zod schema strips the field.
await testPrisma.stackTemplateService.create({
  data: { /* ... */, vaultAppRoleRef: 'my-approle' },
});
const apply = await runApply(stackId);
expect(apply.serviceResults[0].vaultAppRoleRef).toBe('my-approle');

// ✅ Posts a real body and asserts the column is set after the route handler runs.
//    Catches Zod-strip bugs and any future schema drift.
await supertest(app)
  .post(`/api/stack-templates/${tmplId}/draft`)
  .send({ services: [{ /* ... */, vaultAppRoleRef: 'my-approle' }], /* ... */ });
const row = await testPrisma.stackTemplateService.findFirst({ where: { versionId } });
expect(row?.vaultAppRoleRef).toBe('my-approle');
```

Direct Prisma fixture inserts are still the right tool for testing the orchestrator/reconciler in isolation (e.g., "given a row with X, the apply pipeline does Y") — just don't rely on them as a contract test for the public API.

References:
- [`server/src/__tests__/stack-templates-draft-route.integration.test.ts`](src/__tests__/stack-templates-draft-route.integration.test.ts) — example of the supertest-over-fixtures pattern.
- [`server/src/__tests__/service-schema-drift.test.ts`](src/__tests__/service-schema-drift.test.ts) — structural pin so the two service schemas can't drift on the common base again.

### Schemas that share a field set should share a base

When two schemas describe the same logical entity at different layers (e.g. a service in a file-loaded template vs in an HTTP draft body), put the shared fields on a single `z.object({...})` and have each leaf `.extend({...})` it. Refines stay on the leaves; the base is field-only. See `stackServiceCommonFieldsSchema` in [`server/src/services/stacks/schemas.ts`](src/services/stacks/schemas.ts) and how `stackServiceDefinitionSchema` and `templateServiceSchema` build on it. A literal `z.object({...})` per layer is what produced the original `vaultAppRoleRef` drift.

## General Rules

1. **Always use service wrappers over raw SDK calls** — they add caching, auth, retries, circuit breakers, error mapping, and audit logging
2. **Initialize before use** — `DockerService` and `DockerExecutorService` require `initialize()`
3. **Check connection status** — call `isConnected()` before Docker operations
4. **Pass `userId` for all mutations** — configuration changes, credential changes, service operations
5. **Use constants for Socket.IO** — `Channel.*` and `ServerEvent.*` from `lib/types/socket-events.ts`, never raw strings
6. **Handle `null` from config** — `ConfigurationService.get()` returns `null` for missing keys
7. **Let orchestrators build image references** — pass registry, image, and tag as separate values
8. **Wrap socket emissions in try/catch** — emission failures must never break the caller
9. **Use `getLogger(component, subcomponent)`** — not the legacy category-specific factories; see the Logging section above
