# Remove Environment Services & Add Network-Type Defaults to Stack Templates

## Summary

Remove the `EnvironmentService` model and all associated code (health scheduler, service recovery, service registry, port-utils, service API routes, service UI). Replace the port-management functionality with a new `networkTypeDefaults` field on `StackTemplateVersion`, allowing any stack template to declare parameter defaults that vary by environment network type (local vs internet).

## Motivation

Environment services are vestigial. Stacks now handle container lifecycle, deployment, and reconciliation. The only real functionality environment services still provide is:

1. HAProxy port defaults that vary by network type (local: 80/443, internet: 8111/8443)
2. HAProxy container lookup for frontend/backend management routes
3. Service health monitoring and auto-recovery

All three can be replaced by stack-level mechanisms. Removing environment services eliminates a redundant abstraction layer and simplifies the codebase.

## Design

### 1. New Field: `networkTypeDefaults` on StackTemplateVersion

Add a JSON field to `StackTemplateVersion` in the Prisma schema:

```prisma
networkTypeDefaults Json @default("{}") // Record<EnvironmentNetworkType, Record<string, StackParameterValue>>
```

This field maps environment network types to parameter value overrides. Example in the HAProxy template:

```json
"networkTypeDefaults": {
  "internet": {
    "http-port": 8111,
    "https-port": 8443,
    "stats-port": 8405,
    "dataplane-port": 5556,
    "expose-on-host": false
  }
}
```

The `local` network type uses the parameter definition defaults (80, 443, 8404, 5555, true) so it needs no entry.

Any stack template can use this field, not just HAProxy.

### 2. Parameter Merge Order

When instantiating a stack from a template, parameter values are merged in this order (later wins):

1. `parameters[].default` -- base defaults from parameter definitions
2. `networkTypeDefaults[environment.networkType]` -- network-type-specific overrides
3. User-provided `parameterValues` -- explicit user overrides

In `stack-template-service.ts` `createStackFromTemplate()`:

```ts
const networkDefaults = (version.networkTypeDefaults as Record<string, Record<string, StackParameterValue>>)?.[networkType] ?? {};
const mergedValues = mergeParameterValues(paramDefs, {
  ...defaultValues,
  ...networkDefaults,
  ...(input.parameterValues ?? {}),
});
```

The method looks up the environment's `networkType` when `environmentId` is provided.

The same merge logic applies in `builtin-stack-sync.ts` when syncing built-in stacks. The hardcoded `getEnvironmentParameterOverrides()` function is deleted.

### 3. HAProxy Container Lookup Replacement

Seven locations currently use `environment.services.find(s => s.serviceName === 'haproxy')` to find the HAProxy container. These switch to a stack-based lookup:

```ts
const haproxyStack = await prisma.stack.findFirst({
  where: { environmentId, name: 'haproxy', status: { not: 'removed' } },
  include: { services: true },
});
```

A shared helper `findHAProxyStack(prisma, environmentId)` avoids repeating this query. The stack's services provide the container name for connecting to the DataPlane API.

Affected files:
- `server/src/routes/environments.ts` (HAProxy status, remediation, migration routes)
- `server/src/routes/haproxy-backends.ts`
- `server/src/routes/haproxy-frontends.ts`
- `server/src/routes/manual-haproxy-frontends.ts`

### 4. What Gets Deleted

**Database:**
- `EnvironmentService` model from Prisma schema
- `services` relation from `Environment` model
- `environment_services` table (via migration)

**Server services (entire files):**
- `server/src/services/environment/service-recovery.ts` -- stacks manage container lifecycle
- `server/src/services/environment/environment-health-scheduler.ts` -- stack reconciliation handles drift
- `server/src/services/environment/service-registry.ts` -- service types are stack templates
- `server/src/services/port-utils.ts` -- ports live in stack parameter values

**Server routes (endpoints removed):**
- `GET /api/environments/:id/services`
- `POST /api/environments/:id/services`
- `GET /api/environments/services/available`
- `GET /api/environments/services/available/:serviceType`

**Server code (functions/methods removed):**
- `getEnvironmentParameterOverrides()` in `builtin-stack-sync.ts`
- `addServiceToEnvironment()` and `addServicesToEnvironment()` in `environment-manager.ts`
- Service iteration in `deleteEnvironment()` in `environment-manager.ts`

**Frontend (components/hooks removed):**
- `client/src/components/environments/service-add-dialog.tsx`
- Service health display in `environment-card.tsx` and `environment-status.tsx`
- Hooks for fetching/adding environment services

**Types:**
- `EnvironmentService` interface from `lib/types/environments.ts`
- `services` field from `Environment` interface

### 5. What Gets Updated

**Prisma schema:**
- `StackTemplateVersion` -- add `networkTypeDefaults` field
- `Environment` -- remove `services` relation

**Server:**
- `stack-template-service.ts` -- merge logic includes network-type defaults
- `builtin-stack-sync.ts` -- reads `networkTypeDefaults` from template, deletes override function
- `environment-manager.ts` -- remove service-related methods, simplify `deleteEnvironment()`
- `environments.ts` routes -- HAProxy routes use stack-based lookup instead of service lookup
- `haproxy-backends.ts`, `haproxy-frontends.ts`, `manual-haproxy-frontends.ts` -- same stack-based lookup
- `environment-networks.ts`, `environment-volumes.ts` -- remove service iteration if present

**Types:**
- `lib/types/stacks.ts` -- add `networkTypeDefaults` to relevant interfaces
- `lib/types/environments.ts` -- remove `EnvironmentService` and `services` from `Environment`

**Frontend:**
- `environment-card.tsx` -- remove service health badge
- `environment-delete-dialog.tsx` -- remove service warnings
- Environment detail page -- remove "Add Service" button and service health section
- Template-related types/hooks -- add `networkTypeDefaults` to template version types

### 6. Migration Strategy

A single Prisma migration that:

1. Adds `networkTypeDefaults` column (JSON, default `{}`) to `stack_template_versions`
2. Updates existing HAProxy template versions to populate `networkTypeDefaults` with internet port defaults
3. Drops the `environment_services` table

Existing stacks are unaffected -- they already have `parameterValues` baked in from instantiation. The `networkTypeDefaults` field only affects future instantiations and builtin-stack-sync.

### 7. Not In Scope

- UI for editing `networkTypeDefaults` in the template editor (follow-up work)
- Changes to stack deployment/reconciliation logic (unaffected)
- Changes to environment creation/deletion flow beyond removing service references
