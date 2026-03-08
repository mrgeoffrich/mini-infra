# Stacks Feature - Work Plan

Reference: [stacks-feature-design.md](./stacks-feature-design.md)

Each job is scoped to fit within a single Opus context window. Jobs are sequential — each builds on the previous. Within a job, tasks are ordered by dependency.

---

## Job 1: Shared Types and Prisma Schema

**Goal:** Define the data model — Prisma schema, shared TypeScript types, and Zod validation schemas. No business logic.

**Files to create/modify:**
- `server/prisma/schema.prisma` — add Stack, StackService models, StackStatus and ServiceType enums
- `lib/types/stacks.ts` — shared types for Stack, StackService, StackPlan, ServiceAction, FieldDiff, ApplyOptions, ApplyResult, StackContainerConfig, StackConfigFile, StackInitCommand, StackServiceRouting, StackDefinition (portable serialization shape), and all API request/response types
- `lib/types/index.ts` — re-export stacks types

**Details:**
- Stack model: id, name, description, environmentId, version, status (enum: synced/drifted/pending/error/undeployed), lastAppliedVersion, lastAppliedAt, lastAppliedSnapshot, networks (Json), volumes (Json)
- StackService model: id, stackId, serviceName, serviceType (enum: Stateful/StatelessWeb), dockerImage, dockerTag, containerConfig (Json), configFiles (Json), initCommands (Json), dependsOn (Json), order, routing (Json)
- Unique constraint on (stackId, serviceName), unique on (name, environmentId) for Stack
- Relations: Stack belongs to Environment, StackService belongs to Stack
- Run `npx prisma migrate dev --name add-stack-models`
- Define a `StackDefinitionSchema` Zod schema covering the portable subset of a stack (name, description, networks, volumes, services with all config) — excludes DB-only fields (id, version, status, timestamps, environmentId). This schema serves triple duty: validates API request bodies, validates imported files (future git sourcing), and defines the serialization shape for export
- Add `serializeStack(stack) → StackDefinition` that strips DB fields from a full stack + services into the portable shape
- Add `deserializeStack(definition, environmentId) → CreateStackInput` that produces the shape needed to upsert into the DB
- The `lastAppliedSnapshot` field on Stack stores data in this same `StackDefinition` shape, keeping snapshots consistent with the export format

**Verification:** `npx -w server prisma generate` succeeds, `npm run build -w lib` succeeds

---

## Job 2: Definition Hash and Template Engine

**Goal:** Build the two core utilities the reconciler depends on: computing definition hashes for drift detection, and resolving `{{variable}}` templates in config file content.

**Files to create:**
- `server/src/services/stacks/definition-hash.ts` — takes a StackService (with resolved config files), normalizes all fields deterministically, returns a SHA-256 hex digest
- `server/src/services/stacks/template-engine.ts` — takes config file content and a template context (stack name, project name, service container names, volume names, network names, env vars), resolves all `{{...}}` variables, throws on unresolved variables

**Files to create for testing:**
- `server/src/__tests__/stack-definition-hash.test.ts`
- `server/src/__tests__/stack-template-engine.test.ts`

**Details:**
- Hash inputs: dockerImage, dockerTag, containerConfig (JSON with sorted keys), resolved configFiles content, initCommands, routing
- Template variables: `{{stack.name}}`, `{{stack.projectName}}`, `{{services.<name>.containerName}}`, `{{services.<name>.image}}`, `{{env.<key>}}`, `{{volumes.<name>}}`, `{{networks.<name>}}`
- Template context is built from the full Stack + its services + environment prefix
- Error on unknown variables rather than silently leaving them

**Verification:** Tests pass with `npx vitest run`

---

## Job 3: Stack Reconciler — Plan

**Goal:** Build the plan phase of the reconciler. Given a Stack, inspect running Docker containers, compare against desired state, produce a StackPlan with per-service actions and diffs.

**Files to create:**
- `server/src/services/stacks/stack-reconciler.ts` — class with `plan(stackId): Promise<StackPlan>` method
- `server/src/__tests__/stack-reconciler-plan.test.ts`

**Dependencies:** Job 1 (types/schema), Job 2 (definition hash, template engine)

**Details:**
- Load Stack + StackServices from DB
- Build template context, resolve config file templates
- Compute definition hash per service
- Query Docker for running containers with label `mini-infra.stack-id` matching this stack
- For each service: compare definition hash on running container label vs computed hash
- Produce ServiceAction with action (create/recreate/remove/no-op), reason string, and FieldDiff array
- For diff generation: compare current container's image, tag, and stored definition hash. For detailed config diffs, compare the lastAppliedSnapshot's service entry against the current definition
- Handle containers with stack labels that have no matching service definition (action: remove)
- Uses DockerExecutorService for container queries (mock in tests)

**Verification:** Tests cover: all-new stack (all creates), no-change stack (all no-ops), image tag change (recreate with diff), config file change (recreate with diff), removed service (remove), mixed scenario

---

## Job 4: Stack Reconciler — Apply (Stateful)

**Goal:** Build the apply phase for Stateful services. This handles create, recreate (stop-old/start-new), and remove actions.

**Files to modify:**
- `server/src/services/stacks/stack-reconciler.ts` — add `apply(stackId, options?: ApplyOptions): Promise<ApplyResult>` method

**Files to create:**
- `server/src/services/stacks/stack-container-manager.ts` — handles the low-level container operations: pull image, run init container (volume prep + config file writing), create container with labels, start container, wait for healthcheck, stop/remove container
- `server/src/__tests__/stack-reconciler-apply.test.ts`

**Dependencies:** Job 3 (plan)

**Details:**
- `apply()` calls `plan()` first, then executes actions in dependency order
- `serviceNames` filter in ApplyOptions for per-service targeting
- Concurrent apply lock: set a `applying` flag on the Stack row (check-and-set), clear on completion/error
- Init container pattern: one temp Alpine container per volume, runs init commands then writes config files, waits, removes. Consolidate all config files targeting the same volume into one init container run
- Container creation: use DockerExecutorService.createLongRunningContainer with all fields from containerConfig, plus stack labels (mini-infra.stack, mini-infra.stack-id, mini-infra.service, mini-infra.environment, mini-infra.definition-hash, mini-infra.stack-version)
- Healthcheck wait: poll container health status up to the configured timeout
- After all actions: update lastAppliedVersion, lastAppliedAt, lastAppliedSnapshot, status=synced
- On partial failure: mark failed services in result, set stack status=error, still update snapshot for successful services
- Always pull images before creating containers

**Verification:** Tests cover: create new service, recreate service (stop old, start new), remove service, per-service filtering, lock prevents concurrent apply, healthcheck timeout handling

---

## Job 5: Stack Reconciler — Apply (StatelessWeb / Blue-Green)

**Goal:** Extend the apply phase to handle StatelessWeb services using blue-green deployment with HAProxy traffic switching.

**Files to modify:**
- `server/src/services/stacks/stack-reconciler.ts` — add StatelessWeb branch in apply logic
- `server/src/services/stacks/stack-container-manager.ts` — add methods for blue-green lifecycle

**Files to create:**
- `server/src/services/stacks/stack-routing-manager.ts` — manages HAProxy routes and DNS for stack services. Uses existing HAProxyFrontendManager for shared frontend/route/backend operations and DeploymentDNSManager for DNS record lifecycle
- `server/src/__tests__/stack-reconciler-apply-stateless.test.ts`

**Dependencies:** Job 4 (stateful apply)

**Details:**
- StatelessWeb recreate: start new container alongside old, healthcheck new, update HAProxy backend, drain old, remove old
- StatelessWeb create: start container, healthcheck, create HAProxy route (shared frontend + backend + server) via HAProxyFrontendManager, create DNS record if routing.dns is configured
- StatelessWeb remove: remove HAProxy route, remove DNS record, stop/remove container
- Routing manager wraps HAProxyFrontendManager.getOrCreateSharedFrontend(), addRouteToSharedFrontend(), removeRouteFromSharedFrontend()
- DNS follows environment networkType: local + cloudflare provider = create record, internet or external = skip
- On failed healthcheck for new container: remove new container, keep old running, do NOT touch HAProxy routing

**Verification:** Tests cover: blue-green recreate flow, create with routing + DNS, remove with route cleanup, healthcheck failure keeps old container

---

## Job 6: Seed Utility

**Goal:** Build the seed functions that create Stack records from the existing hardcoded MonitoringService and HAProxyService implementations. These run on first startup or via an API endpoint.

**Files to create:**
- `server/src/services/stacks/seed-monitoring-stack.ts` — creates the monitoring Stack with 4 services (telegraf, prometheus, loki, alloy), extracting all container config, config file content, init commands from the current MonitoringService code
- `server/src/services/stacks/seed-haproxy-stack.ts` — creates the HAProxy Stack with 1 service, extracting container config and config files from HAProxyService
- `server/src/services/stacks/seed.ts` — orchestrator that checks if stacks already exist, runs seeds if not, handles idempotency

**Dependencies:** Job 1 (schema)

**Details:**
- Extract exact values from current MonitoringService: images, tags, ports, mounts, env, command, entrypoint, user, healthcheck, restart policy, log config
- Extract config file content: telegraf.conf, prometheus.yml, loki config, alloy config (with `{{services.loki.containerName}}` template)
- Extract init commands: prometheus data dir setup (chown 65534), loki dir setup (chown 10001)
- Extract exact values from HAProxyService: image, ports (use defaults — dynamic port resolution happens at apply time), mounts, env, healthcheck, config files (haproxy.cfg, dataplaneapi.yml, domain-backend.map read from server/docker-compose/haproxy/)
- All seeds are idempotent: skip if stack with same name+environmentId exists
- Seed runs during environment creation or via a manual API endpoint

**Verification:** Manual verification — run seed, inspect DB records, verify they match the current hardcoded implementations

---

## Job 7: API Endpoints

**Goal:** Build the REST API for stacks — CRUD, plan, apply, status, and history.

**Files to create:**
- `server/src/routes/stacks.ts` — all stack endpoints
- `server/src/__tests__/stacks-api.test.ts`

**Files to modify:**
- `server/src/routes/index.ts` — register stacks router

**Dependencies:** Job 4 (reconciler apply), Job 5 (StatelessWeb apply)

**Endpoints:**
- `GET /api/stacks` — list stacks, filterable by environmentId
- `GET /api/stacks/:stackId` — get stack with all services
- `POST /api/stacks` — create stack (validates service types, routing requirements)
- `PUT /api/stacks/:stackId` — update stack definition, bumps version, sets status to pending
- `DELETE /api/stacks/:stackId` — delete stack (must be undeployed or have no running containers)
- `PUT /api/stacks/:stackId/services/:serviceName` — update single service, bumps stack version
- `GET /api/stacks/:stackId/plan` — compute and return plan
- `POST /api/stacks/:stackId/apply` — apply changes, body: `{ serviceNames?, dryRun? }`
- `GET /api/stacks/:stackId/status` — current status with per-service container state
- `GET /api/stacks/:stackId/history` — list applied version snapshots
- `GET /api/stacks/:stackId/history/:version` — specific snapshot

**Details:**
- Zod validation on all request bodies
- Permission checks consistent with existing route patterns
- Apply endpoint returns immediately with a job ID, progress streamed via existing patterns (or polled via status endpoint)
- Plan endpoint is synchronous (fast — just Docker queries + hash comparison)

**Verification:** API tests cover: CRUD operations, plan returns correct actions, apply triggers reconciler, validation rejects invalid service type + routing combinations

---

## Job 8: Plan/Apply Diff UI Component

**Goal:** Build the React component that shows the plan diff and allows applying changes. Embeddable in existing pages.

**Files to create:**
- `client/src/components/stacks/StackPlanView.tsx` — main component: fetches plan, shows per-service action list, expandable diffs, Apply All / Apply Selected buttons
- `client/src/components/stacks/ServiceActionRow.tsx` — single service row: icon for action type, service name, image info, reason text, expandable diff detail
- `client/src/components/stacks/StackApplyProgress.tsx` — apply progress display: per-service status updates, success/failure indicators, duration
- `client/src/components/stacks/StackDiffView.tsx` — renders FieldDiff array as a unified diff (red/green lines for old/new values)
- `client/src/hooks/useStacks.ts` — TanStack Query hooks: useStackPlan, useStackApply (mutation), useStackStatus, useStacks

**Dependencies:** Job 7 (API endpoints)

**Details:**
- StackPlanView fetches plan on mount, shows loading skeleton, then renders service action list
- Each ServiceActionRow shows: service name, action badge (no change / create / recreate / remove), image info, reason
- Clicking a recreate/create row expands to show StackDiffView with field-level changes
- Apply button triggers mutation, switches to StackApplyProgress view
- Apply progress polls status endpoint for per-service updates
- Support selecting individual services for per-service apply
- Use existing UI patterns: shadcn Card, Badge, Collapsible, Skeleton, Button, sonner toast for success/error

**Verification:** Manual — component renders plan, shows diffs, apply triggers correctly

---

## Job 9: Integration — Embed in Environment Page

**Goal:** Wire the StackPlanView into the existing environment detail page so users can see stack status and apply changes for their environment's stacks.

**Files to modify:**
- `client/src/app/environments/` — relevant environment detail page: add a "Stacks" section/tab that lists stacks for the environment, each showing StackPlanView
- `server/src/services/environment/environment-manager.ts` — call seed utility during environment creation to auto-create monitoring and haproxy stacks

**Files to modify (if needed):**
- Monitoring page — add stack status indicator showing whether monitoring stack is synced/drifted

**Dependencies:** Job 6 (seed), Job 8 (UI components)

**Details:**
- Environment detail page gets a new section showing all stacks for that environment
- Each stack shows: name, status badge (synced/drifted/pending/error), service count, last applied time
- Clicking a stack expands to show StackPlanView inline
- On environment creation, seed utility auto-creates monitoring and haproxy stacks
- Existing environment start/stop continues to work via IApplicationService — stacks are additive for now

**Verification:** Manual end-to-end — create environment, see seeded stacks, view plan, apply a change (e.g. bump an image tag), verify container updated

---

## Job 10: Cut-Over — Stack Reconciler Replaces IApplicationService Deploy

**Goal:** Wire environment start/stop to use the stack reconciler instead of the hardcoded IApplicationService.start() for container deployment. Keep IApplicationService for health checks and status only.

**Files to modify:**
- `server/src/services/environment/environment-manager.ts` — in `startEnvironment()`, after provisioning infrastructure, use stack reconciler apply instead of IApplicationService.start() for deploying containers. In `stopEnvironment()`, use stack reconciler to stop stack-managed containers
- `server/src/services/monitoring/monitoring-service.ts` — remove deploy methods (deployTelegraf, deployPrometheus, deployLoki, deployAlloy, config writing methods). Keep healthCheck, getStatus, metadata, stopAndCleanup (for backward compat during transition)
- `server/src/services/haproxy/haproxy-service.ts` — remove deployHAProxy, deployHAProxyContainer, writeConfigsToVolume, createVolumes, createNetwork. Keep healthCheck, getStatus, metadata, getProjectContainers

**Dependencies:** All previous jobs

**Details:**
- Environment start flow becomes: provision networks/volumes → for each stack in environment, run reconciler.apply() → update environment status
- Environment stop flow becomes: for each stack in environment, stop all containers via reconciler → update environment status
- IApplicationService implementations become thin wrappers for health/status only
- The hardcoded container definitions in MonitoringService/HAProxyService are now dead code — the stack DB records are the source of truth
- Ensure existing monitoring start/stop buttons on the monitoring page still work (they should — they go through environment manager)

**Verification:** Full end-to-end — start environment, verify all containers created by reconciler with correct labels, stop environment, verify containers removed. Change a stack service definition, verify plan shows change, apply, verify container updated.
