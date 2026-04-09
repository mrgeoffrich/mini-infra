# Stack System

This document explains how the Mini Infra stack system works, covering architecture, data flow, plan/apply semantics, blue-green deployments, templates, and resource management. It concludes with a code review section identifying duplication and maintainability concerns.

## Table of Contents

- [Overview](#overview)
- [Data Model](#data-model)
- [Stack Templates](#stack-templates)
- [Plan/Apply Lifecycle](#planapply-lifecycle)
- [Service Types](#service-types)
- [Blue-Green Deployment](#blue-green-deployment)
- [Resource Reconciliation](#resource-reconciliation)
- [Infrastructure Resources](#infrastructure-resources)
- [Drift Detection](#drift-detection)
- [Real-Time Progress Tracking](#real-time-progress-tracking)
- [Applications (Simplified UX)](#applications-simplified-ux)
- [File Map](#file-map)
- [Code Review: Duplication and Maintainability](#code-review-duplication-and-maintainability)

---

## Overview

A **Stack** is a group of containers and supporting infrastructure (networks, volumes, config files, TLS certificates, DNS records, tunnel ingress rules) managed as a single unit. Stacks use **plan/apply semantics** inspired by Terraform: you generate a plan showing what will change, then apply it to converge the actual state to the desired state.

Stacks sit at the center of Mini Infra's orchestration layer:

```
  Stack Template (blueprint)
        │
        ▼
      Stack (desired state in DB)
        │
        ├── StackService[] (service definitions)
        ├── StackResource[] (TLS, DNS, tunnel state)
        ├── Networks, Volumes, Parameters
        │
        ▼
  StackReconciler.plan()  →  StackPlan (diff)
        │
        ▼
  StackReconciler.apply() →  Docker containers + HAProxy routes + DNS/TLS/Tunnels
```

## Data Model

### Prisma Models

| Model | Purpose |
|---|---|
| `Stack` | Primary entity. Holds desired state, parameters, resource definitions, status, and a snapshot of the last-applied state. |
| `StackService` | Individual service within a stack. Defines image, config, routing, and service type. Unique on `(stackId, serviceName)`. |
| `StackDeployment` | Immutable audit log of every apply/update/stop operation, including per-service results and duration. |
| `StackResource` | Tracks external resources (TLS certs, DNS records, tunnel ingress) with `externalId` and `externalState`. |
| `StackTemplate` | Reusable blueprint with draft/published versioning. Source: `system` (built-in) or `user` (custom). |
| `StackTemplateVersion` | Immutable snapshot of a template. Version 0 = draft; published versions are sequential. |
| `StackTemplateService` | Service definition within a template version. |
| `StackTemplateConfigFile` | Config file with `{{template}}` variable support. |
| `InfraResource` | Shared infrastructure resources (e.g., Docker networks) that stacks can create and consume across environments. |

### Status Lifecycle

```
undeployed  ──apply──▶  synced
                          │
                    drift detected
                          │
                          ▼
                        drifted  ──apply──▶  synced
                          │
                     apply fails
                          │
                          ▼
                        error  ──apply──▶  synced
                          │
                       destroy
                          │
                          ▼
                       removed
```

## Stack Templates

Templates are reusable blueprints for stacks. They support a draft-and-publish workflow:

1. **Create template** with an initial draft version (version 0)
2. **Edit the draft** - add/modify services, parameters, config files, networks, volumes
3. **Publish** the draft as version N (immutable snapshot)
4. **Instantiate** a stack from a published version

### Template Scoping

- **Host-scoped**: Stack deploys at the host level (no environment)
- **Environment-scoped**: Stack deploys within a specific environment, gaining access to environment networks and routing

### Parameters

Templates define parameters with types (`string`, `number`, `boolean`), defaults, and validation rules (min, max, pattern, options). When instantiating a stack, parameter values are merged with defaults and used to resolve `{{params.name}}` variables in config files and environment variables.

### Config File Template Variables

Config files support Handlebars-style variables resolved at apply time:

| Variable | Resolves To |
|---|---|
| `{{stack.name}}` | Stack name |
| `{{stack.projectName}}` | `{environment}-{stack}` or just `{stack}` for host stacks |
| `{{services.{name}.containerName}}` | Resolved container name for a service |
| `{{params.{name}}}` | Parameter value |
| `{{env.name}}` | Environment name |

## Plan/Apply Lifecycle

### Plan Phase

`StackReconciler.plan(stackId)` computes what needs to change:

1. **Load stack** with services, environment, and template version from DB
2. **Resolve templates**: merge parameter values, build template context, resolve config file variables
3. **Compute definition hashes** for each service (image + config + routing)
4. **Query running containers** for this stack via Docker labels
5. **Compare desired vs actual** for each service:
   - **Hash match** → `no-op`
   - **Hash mismatch** → `recreate` (with field-level diffs showing what changed)
   - **No container exists** → `create`
   - **Container exists but service removed** → `remove` (orphan)
6. **Detect conflicts**: port collisions with other containers, name collisions
7. **Plan resources**: diff TLS certificates, DNS records, and tunnel ingress rules
8. Return `StackPlan` with `ServiceAction[]`, `ResourceAction[]`, and `PlanWarning[]`

### Apply Phase

`StackReconciler.apply(stackId, options?)` executes the plan:

1. **Get or compute plan** (accepts pre-computed plan via options)
2. **Force-pull** (optional): pull all images; if the pulled digest differs from the running container's image, promote `no-op` → `recreate`
3. **Filter actions** by `serviceNames` if provided (partial apply)
4. **Dry-run**: return plan without executing if `dryRun: true`
5. **Resolve parameters and template context**
6. **Reconcile infrastructure**:
   - Create Docker networks for resource outputs
   - Resolve resource inputs from other stacks
   - Ensure stack-owned networks and volumes exist
7. **Reconcile stack resources** (ordered): DNS → TLS → Tunnels
8. **Sort actions**: creates first, recreates second, removes last (respecting service order within each group)
9. **Execute actions** per service type:
   - `Stateful` → direct container create/recreate/remove
   - `StatelessWeb` → state machine (initial deployment, blue-green, or removal)
   - `AdoptedWeb` → routing-only (find container, configure HAProxy, never stop container)
10. **Update stack** in DB with `lastAppliedSnapshot` and status
11. **Record deployment** in `StackDeployment` for audit trail

### Update Phase

`StackReconciler.update(stackId, options?)` is like apply but optimized for image updates:

- Always force-pulls images first
- Optionally promotes all `no-op` actions to `recreate` (`forceRecreate`)
- Skips resource reconciliation (DNS/TLS/Tunnel unchanged)
- Uses `blueGreenUpdateMachine` instead of `blueGreenDeploymentMachine` for StatelessWeb recreates
- Records action as `'update'` in deployment history

### Destroy

`StackReconciler.destroyStack(stackId)` tears everything down:

- Stops and removes all containers
- Removes stack-owned Docker networks and volumes
- Removes HAProxy routing
- Updates stack status to `removed`

## Service Types

### Stateful

Traditional Docker containers with direct lifecycle management. Best for databases, caches, workers, and anything that doesn't need load balancing.

- **Create**: pull image → write config files → run init commands → create container → wait for health
- **Recreate**: stop old container → create new container (same process as create)
- **Remove**: stop and remove container

### StatelessWeb

Load-balanced web services with zero-downtime deployments via HAProxy. Requires routing configuration (hostname, listening port, health check endpoint).

- **Create**: state machine (`initialDeploymentMachine`) - create container → health check → configure HAProxy backend/route → enable traffic
- **Recreate**: state machine (`blueGreenDeploymentMachine`) - blue-green deployment (see below)
- **Update**: state machine (`blueGreenUpdateMachine`) - similar to recreate but used during `update()` operations
- **Remove**: state machine (`removalDeploymentMachine`) - drain → remove from HAProxy → remove DNS → stop container

### AdoptedWeb

External containers managed outside Mini Infra. Mini Infra only manages HAProxy routing, never the container lifecycle.

- **Create**: find container by name → join to HAProxy network → configure backend/server → configure route → enable traffic
- **Recreate**: remove old routing → re-create routing (same as create)
- **Remove**: drain server → remove routing (container is **never** stopped)

## Blue-Green Deployment

For `StatelessWeb` services, recreate operations use a blue-green deployment strategy orchestrated by XState state machines:

```
                    ┌──────────────────────────┐
                    │    Create Green Container │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Wait for Health Checks   │
                    │  (both blue and green)     │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Configure Green Backend  │
                    │  in HAProxy               │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Open Traffic to Green    │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Validate Traffic         │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Drain Blue               │
                    │  (stop accepting new)     │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Wait for Active          │
                    │  Connections → 0          │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  Remove Blue Container    │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │        Completed          │
                    └───────────────────────────┘
```

**Auto-rollback**: if green fails health checks or traffic validation, the state machine rolls back to blue automatically.

### State Machines

| Machine | File | Used When |
|---|---|---|
| `initialDeploymentMachine` | `haproxy/initial-deployment-state-machine.ts` | First deploy of a StatelessWeb service |
| `blueGreenDeploymentMachine` | `haproxy/blue-green-deployment-state-machine.ts` | Recreate during `apply()` |
| `blueGreenUpdateMachine` | `haproxy/blue-green-update-state-machine.ts` | Recreate during `update()` |
| `removalDeploymentMachine` | `haproxy/removal-deployment-state-machine.ts` | Removing a StatelessWeb service |

All machines are executed via `runStateMachineToCompletion()` which creates an XState actor, sends the start event, and awaits the final state.

## Resource Reconciliation

`StackResourceReconciler` manages external resources tied to stacks:

### Resource Types

| Type | What It Manages |
|---|---|
| `tls` | TLS certificates via ACME (Let's Encrypt), DNS-01 challenge via Cloudflare, stored in Azure Blob Storage |
| `dns` | Cloudflare DNS records (A records with TTL and proxying settings) |
| `tunnel` | Cloudflare tunnel ingress rules for public internet access |

### Reconciliation Order

Resources are reconciled in a specific order during apply: **DNS → TLS → Tunnels**. This ensures DNS records exist before TLS certificate validation, and tunnels are configured after both.

### How It Works

1. **Plan**: compare desired resource definitions against existing `StackResource` records. Generate create/update/remove/no-op actions.
2. **Reconcile**: for each resource type, execute the planned actions against external APIs (Cloudflare, ACME). Upsert `StackResource` records with `externalId` and `externalState`.

## Infrastructure Resources

Stacks can declare infrastructure resource **outputs** and **inputs** for sharing Docker networks across stacks:

### Resource Outputs

A stack declares networks it creates:

```json
{
  "type": "docker-network",
  "purpose": "applications",
  "scope": "environment",
  "joinSelf": true
}
```

When applied, the reconciler creates the Docker network and records it in the `InfraResource` table. If `joinSelf: true`, the mini-infra container itself joins the network.

### Resource Inputs

A stack declares networks it consumes:

```json
{
  "type": "docker-network",
  "purpose": "applications",
  "scope": "environment",
  "optional": false
}
```

The reconciler resolves inputs by looking up matching `InfraResource` records. Required inputs that are missing cause the apply to fail.

### Use Case

This is how HAProxy's network is shared with application stacks. The HAProxy stack outputs an `applications` network; application stacks input it so their containers can be reached by the load balancer.

## Drift Detection

Drift is detected via **definition hashing** (`definition-hash.ts`):

1. Each service definition is hashed deterministically: `dockerImage` + `dockerTag` + `containerConfig` + `configFiles` + `initCommands` + `routing`
2. The hash is stored as a Docker label on the container: `mini-infra.definition-hash`
3. During plan, the desired hash is compared against the running container's hash
4. A mismatch means the service definition changed → the plan will show a `recreate` action with field-level diffs

Additionally:
- `lastAppliedSnapshot` stores the complete stack definition at the time of last successful apply
- `lastAppliedVersion` tracks which stack version was last applied
- Parameter value changes are captured because parameters are resolved into config before hashing

## Real-Time Progress Tracking

Stack operations emit Socket.IO events for real-time UI updates:

| Event | Payload | When |
|---|---|---|
| `stack:apply:started` | stackId, stackName, totalActions, actions[], forcePull | Apply begins |
| `stack:apply:service-result` | ServiceApplyResult, completedCount, totalActions | Each service completes |
| `stack:apply:completed` | ApplyResult (success, serviceResults, duration) | Apply finishes |
| `stack:destroy:started` | stackId, stackName | Destroy begins |
| `stack:destroy:completed` | DestroyResult | Destroy finishes |
| `stack:status` | stackId, status, containers[] | Status changes |

All events are emitted on the `"stacks"` channel. The frontend subscribes via `useSocketChannel('stacks')` and `useSocketEvent()`.

### Frontend Task Tracker Integration

Stack operations are registered with the global task tracker so users can monitor progress across page navigations. The `StackApplyProgress` component shows live per-service results during an apply.

## Applications (Simplified UX)

**Applications** are a user-facing abstraction built on top of stack templates. Under the hood:

- An Application = a `StackTemplate` with `source: "user"`
- Deploying an application = instantiating a stack from that template
- The application UI hides stack/template complexity and presents a simpler form: image, ports, env vars, volumes, routing

The application pages (`applications/new/page.tsx`, `applications/[id]/page.tsx`) convert form data into `CreateStackTemplateRequest` / `UpdateStackTemplateRequest` payloads, delegating all orchestration to the stack system.

## File Map

### Backend (`server/src/services/stacks/`)

| File | Lines | Responsibility |
|---|---|---|
| `stack-reconciler.ts` | ~2100 | Core orchestrator: plan, apply, update, destroy, and per-service-type dispatch |
| `stack-template-service.ts` | ~1130 | Template CRUD, draft/publish versioning, instantiation |
| `stack-resource-reconciler.ts` | ~620 | TLS, DNS, and tunnel resource lifecycle |
| `builtin-stack-sync.ts` | ~416 | Sync system stack templates from YAML files on startup |
| `schemas.ts` | ~324 | Zod validation schemas for stack API requests |
| `stack-routing-manager.ts` | ~282 | HAProxy integration (backend/server/route/frontend management) |
| `template-file-loader.ts` | ~284 | Load built-in stack templates from YAML files |
| `utils.ts` | ~276 | Serialization, template context building, container maps, service config resolution |
| `stack-container-manager.ts` | ~267 | Docker image pulling, init commands, config file writing |
| `template-engine.ts` | ~176 | Handlebars-style variable resolution for config files |
| `stack-event-log-formatter.ts` | ~131 | Human-readable event descriptions for stack operations |
| `stack-template-schemas.ts` | ~84 | Zod schemas for template API requests |
| `definition-hash.ts` | ~57 | Deterministic hashing for change detection |
| `state-machine-runner.ts` | ~26 | XState machine execution helper |

### Routes (`server/src/routes/`)

| File | Endpoints |
|---|---|
| `stacks.ts` (~1400 lines) | 15 endpoints: CRUD, plan, apply, update, destroy, status, history, validate, eligible-containers |
| `stack-templates.ts` (~232 lines) | 11 endpoints: CRUD, versions, draft, publish, instantiate |

### Frontend (`client/src/`)

| Area | Key Files |
|---|---|
| Hooks | `hooks/use-stacks.ts` (600 lines), `hooks/use-stack-templates.ts` (342 lines), `hooks/use-applications.ts` (576 lines) |
| Stack UI | `components/stacks/StackPlanView.tsx` (515 lines), `StackApplyProgress.tsx` (271 lines), `ServiceActionRow.tsx` (132 lines), `StackDiffView.tsx` (48 lines) |
| Template Editor | `stack-templates/` - 9 components for template metadata, services, parameters, networks/volumes, versioning |
| Application Pages | `applications/new/page.tsx` (1118 lines), `applications/[id]/page.tsx` (878 lines), `applications/page.tsx` (496 lines), `applications/adopt/page.tsx` (488 lines) |

### Shared Types (`lib/types/`)

| File | What It Defines |
|---|---|
| `stacks.ts` | Stack, StackService, StackPlan, ServiceAction, ApplyResult, DestroyResult, all request/response types |
| `stack-templates.ts` | StackTemplate, StackTemplateVersion, StackTemplateService, create/update request types |
| `socket-events.ts` | Stack-related Socket.IO channels and events |

---

## Code Review: Duplication and Maintainability

### Summary

The stack system is well-architected with clean separation of concerns (reconciler, resource reconciler, routing manager, container manager, template engine). The plan/apply pattern is solid and the state machine approach for blue-green deployments is robust.

However, there are meaningful duplication patterns in both the backend reconciler and the frontend application forms that would benefit from refactoring.

---

### Backend: `apply()` and `update()` share ~150 lines of near-identical code

**Severity: High** | File: `server/src/services/stacks/stack-reconciler.ts`

The `apply()` (lines 491-792) and `update()` (lines 794-984) methods share substantial blocks of identical code:

**1. Parameter resolution and template context (apply:538-546 vs update:845-851)**
```typescript
// Identical in both methods:
const params = mergeParameterValues(...);
const templateContext = buildStackTemplateContext(stack, params);
const serviceMap = new Map(stack.services.map((s) => [s.serviceName, s]));
const { resolvedConfigsMap, resolvedDefinitions, serviceHashes } = resolveServiceConfigs(...);
```

**2. Infrastructure reconciliation (apply:548-557 vs update:853-858)**
```typescript
// Identical in both methods:
const outputNetworkMap = await this.reconcileInfraOutputs(stack, resourceOutputs, log);
const inputNetworkMap = await this.resolveInfraInputs(stack.environmentId, resourceInputs, log);
const infraNetworkMap = new Map([...outputNetworkMap, ...inputNetworkMap]);
```

**3. Container listing (apply:653-658 vs update:860-865)**
```typescript
// Identical in both methods:
const containers = await docker.listContainers({
  all: true,
  filters: { label: [`mini-infra.stack-id=${stackId}`] },
});
const containerByService = buildContainerMap(containers);
```

**4. Stack status update + snapshot serialization (apply:718-756 vs update:916-949)**

Both methods have the exact same `serializeStack()` call with identical field mapping (~15 lines), followed by the same `prisma.stackDeployment.create()` call.

**5. Error handling catch blocks (apply:766-791 vs update:959-983)**

Nearly identical: create a failed deployment record, update stack status to error, re-throw.

**Suggested fix**: Extract a shared `executeActions()` private method that handles steps 4-9 of apply, parameterized by:
- `actionType`: `'apply'` | `'update'`
- Whether to run resource reconciliation
- Which state machine to use for StatelessWeb recreates

This would reduce `apply()` and `update()` to ~30 lines each of setup logic, delegating to the shared method for execution.

---

### Backend: `applyStatelessWeb()` and `updateStatelessWeb()` overlap

**Severity: Medium** | File: `stack-reconciler.ts` lines 1711-1938

`updateStatelessWeb()` is essentially the `recreate` case of `applyStatelessWeb()` but using `blueGreenUpdateMachine` instead of `blueGreenDeploymentMachine`. The shared logic:

- Routing validation (~3 lines)
- `buildStateMachineContext()` call
- `prepareServiceContainer()` call
- Blue-green context construction (~20 lines, nearly identical)
- State machine execution and result mapping

**Suggested fix**: Merge into a single method with a `machine` parameter, or extract the shared blue-green setup into a helper.

---

### Backend: AdoptedWeb routing cleanup duplicated

**Severity: Medium** | File: `stack-reconciler.ts` lines 1527-1563 vs 1663-1679

The `recreate` and `remove` cases in `applyAdoptedWeb()` both:
1. Get HAProxy context and initialize client
2. Build a `StackRoutingContext`
3. Look up backend record by name
4. Iterate servers and delete/drain them
5. Call `removeRoute()`

**Suggested fix**: Extract a `cleanupAdoptedWebRouting()` private method.

---

### Backend: HAProxy client initialization repeated

**Severity: Low** | File: `stack-reconciler.ts` (multiple locations)

The pattern of getting HAProxy context + creating and initializing the data plane client appears 4+ times in `applyAdoptedWeb()` alone:

```typescript
const haproxyCtx = await this.routingManager!.getHAProxyContext(stack.environmentId);
const haproxyClient = new (await import('../haproxy')).HAProxyDataPlaneClient();
await haproxyClient.initialize(haproxyCtx.haproxyContainerId);
```

**Suggested fix**: Add a helper method `getInitializedHAProxyClient(environmentId)` that returns both the context and initialized client.

---

### Backend: `lastAppliedSnapshot` serialization is inline

**Severity: Low** | File: `stack-reconciler.ts` lines 723-737 and 922-934

The same 15-line block of Prisma JSON field casting appears in both `apply()` and `update()`:

```typescript
lastAppliedSnapshot: serializeStack({
  ...stack,
  networks: stack.networks as unknown as StackNetwork[],
  volumes: stack.volumes as unknown as StackVolume[],
  services: stack.services.map((s) => ({
    ...s,
    serviceType: s.serviceType as StackServiceDefinition['serviceType'],
    containerConfig: s.containerConfig as unknown as StackContainerConfig,
    // ... more casting
  })),
} as any) as any,
```

**Suggested fix**: Extract a `buildAppliedSnapshot(stack)` utility function in `utils.ts`.

---

### Frontend: Application create and edit pages are ~80% duplicate

**Severity: High** | Files: `client/src/app/applications/new/page.tsx` (1118 lines) and `client/src/app/applications/[id]/page.tsx` (878 lines)

These two files share:

- **Identical Zod schemas** (lines 52-105 in new, 49-92 in edit): `envVarSchema`, `portMappingSchema`, `volumeMountSchema`, `routingSchema`, `applicationFormSchema`. The edit page even has a comment `// ---- Zod Schema (same as new page) ----`
- **Identical `useFieldArray` setup** for ports, env vars, and volumes
- **Nearly identical form JSX** for all form sections (service type, image, ports, env vars, volumes, routing, health checks)

The edit page additionally handles:
- Loading existing data and resetting the form
- `enableSsl` and `enableTunnel` fields in its routing schema (missing from new page - a divergence bug?)
- No `deployImmediately` or `enableHealthCheck` fields

**Suggested fix**:
1. Extract shared schemas to `client/src/lib/application-schemas.ts`
2. Extract the form body into a shared `ApplicationForm` component that accepts `mode: 'create' | 'edit'` and optional initial data
3. Keep the page components thin: just data loading (edit) or defaults (create), plus the submit handler

---

### Frontend: Zod schemas fragmented across 3+ files

**Severity: Medium** | Files: `applications/new/page.tsx`, `applications/[id]/page.tsx`, `stack-templates/service-edit-dialog.tsx`

`envVarSchema`, `portMappingSchema`, and `routingSchema` are redefined with slight variations in 3 files. The service-edit-dialog has its own port validation shape that's structurally similar but not identical.

**Suggested fix**: Create a single `client/src/lib/stack-form-schemas.ts` that exports these shared schemas. Individual pages can `.extend()` or `.merge()` for page-specific fields.

---

### Frontend: Routing schema divergence between create and edit

**Severity: Medium (potential bug)** | Files: `applications/new/page.tsx:76-79` vs `applications/[id]/page.tsx:65-70`

The create page's routing schema:
```typescript
const routingSchema = z.object({
  hostname: z.string().min(1, "Hostname is required"),
  listeningPort: z.number().int().min(1).max(65535),
});
```

The edit page adds:
```typescript
const routingSchema = z.object({
  hostname: z.string().min(1, "Hostname is required"),
  listeningPort: z.number().int().min(1).max(65535),
  enableSsl: z.boolean().optional(),
  enableTunnel: z.boolean().optional(),
});
```

This means SSL and tunnel settings can be configured on edit but not on create. This looks like a divergence bug where the create page wasn't updated when these features were added.

---

### Frontend: API fetch patterns repeated

**Severity: Low** | Files: `use-stacks.ts`, `use-stack-templates.ts`, `use-applications.ts`

Each hook file repeats the same fetch-check-parse pattern:

```typescript
const response = await fetch(url, { headers: { 'x-api-key': apiKey, 'x-correlation-id': id } });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const data = await response.json();
if (!data.success) throw new Error(data.error || 'Failed');
return data;
```

And the correlation ID generation:

```typescript
const correlationId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
```

**Suggested fix**: Extract a shared `apiFetch<T>(url, options)` utility that handles headers, error checking, and JSON parsing.

---

### Overall Assessment

| Area | Health | Notes |
|---|---|---|
| Architecture | Good | Clean separation: reconciler, resource reconciler, routing manager, container manager, template engine |
| Plan/Apply semantics | Good | Solid diffing with field-level changes, warnings, and dry-run support |
| Blue-green deployments | Good | State machines are well-structured with auto-rollback |
| Template system | Good | Draft/publish versioning, parameter resolution, config file templating all work well |
| Backend duplication | Needs work | `apply()` and `update()` should share execution logic |
| Frontend duplication | Needs work | Application create/edit forms should be consolidated |
| Test coverage | Good | 9 test files covering plan, apply, resources, templates, and API filtering |
| Type safety | Mixed | Good type definitions in `lib/types/`, but Prisma JSON fields require extensive `as unknown as` casting in the reconciler |

### Refactoring Priority

1. **Extract shared execution logic from `apply()`/`update()`** - highest impact, eliminates ~150 lines of duplication and reduces risk of the two methods drifting apart
2. **Consolidate application form pages** - eliminates ~500 lines of duplication and the routing schema divergence bug
3. **Extract shared Zod schemas** - prevents future divergence across form files
4. **Extract `buildAppliedSnapshot()` utility** - small but removes ugly inline casting
5. **Extract `cleanupAdoptedWebRouting()` helper** - reduces noise in `applyAdoptedWeb()`
6. **Create shared `apiFetch()` utility** - minor but improves consistency
