# Remove Environment Services & Add Network-Type Defaults

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the EnvironmentService abstraction and replace its port-management functionality with network-type-aware defaults on stack templates.

**Architecture:** Add `networkTypeDefaults` to StackTemplateVersion so templates declare parameter overrides per network type. The parameter merge order becomes: definition defaults → network-type defaults → user overrides. All HAProxy container lookups switch from environment.services to stack queries. Everything else environment-service-related is deleted.

**Tech Stack:** Prisma, Express, React, TypeScript, Vitest

---

## File Map

### Created
- `server/prisma/migrations/<timestamp>_add_network_type_defaults_remove_env_services/migration.sql` — schema migration

### Modified
- `server/prisma/schema.prisma` — add `networkTypeDefaults` to StackTemplateVersion, remove EnvironmentService model
- `lib/types/stack-templates.ts` — add `networkTypeDefaults` to type interfaces
- `lib/types/environments.ts` — remove EnvironmentService and services from Environment
- `server/templates/haproxy/template.json` — add `networkTypeDefaults` section
- `server/src/services/stacks/template-file-loader.ts` — parse `networkTypeDefaults` from template files
- `server/src/services/stacks/stack-template-service.ts` — pass `networkTypeDefaults` through upsert and merge during instantiation
- `server/src/services/stacks/builtin-stack-sync.ts` — read network-type defaults from template, remove hardcoded overrides
- `server/src/routes/environments.ts` — remove service endpoints, switch HAProxy lookups to stack queries
- `server/src/routes/haproxy-backends.ts` — switch HAProxy lookup to stack query
- `server/src/routes/haproxy-frontends.ts` — switch HAProxy lookup to stack query
- `server/src/routes/manual-haproxy-frontends.ts` — switch HAProxy lookup to stack query
- `server/src/services/environment/environment-manager.ts` — remove service methods, simplify deleteEnvironment
- `server/src/services/environment/index.ts` — remove service-related exports
- `client/src/components/environments/environment-card.tsx` — remove service health display
- `client/src/components/environments/environment-status.tsx` — remove ServiceHealth or keep if used elsewhere
- `client/src/components/environments/index.ts` — remove service-related exports
- `client/src/hooks/use-environments.ts` — remove service hooks
- `client/src/app/environments/[id]/page.tsx` — remove Add Service button and service display
- `server/src/__tests__/environment-api.test.ts` — remove service endpoint tests, update mocks
- `server/src/__tests__/environment-manager.test.ts` — remove service method tests

### Deleted
- `server/src/services/environment/service-recovery.ts`
- `server/src/services/environment/environment-health-scheduler.ts`
- `server/src/services/environment/service-registry.ts`
- `server/src/services/port-utils.ts`
- `client/src/components/environments/service-add-dialog.tsx`
- `server/src/__tests__/service-registry.test.ts`
- `server/src/__tests__/port-utils.test.ts`

---

### Task 1: Add networkTypeDefaults to Shared Types

**Files:**
- Modify: `lib/types/stack-templates.ts:43-58` (StackTemplateVersion)
- Modify: `lib/types/stack-templates.ts:106-122` (StackTemplateVersionInfo)
- Modify: `lib/types/stack-templates.ts:150-164` (CreateStackTemplateRequest)
- Modify: `lib/types/stack-templates.ts:182-190` (DraftVersionInput)
- Modify: `lib/types/stacks.ts:12-14` (StackParameterValue type — needed for the new field's type)

- [ ] **Step 1: Add networkTypeDefaults to StackTemplateVersion**

In `lib/types/stack-templates.ts`, add the field after `defaultParameterValues` in each interface:

```typescript
// In StackTemplateVersion (line ~50, after defaultParameterValues):
networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;

// In StackTemplateVersionInfo (line ~113, after defaultParameterValues):
networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;

// In CreateStackTemplateRequest (line ~159, after defaultParameterValues):
networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;

// In DraftVersionInput (line ~184, after defaultParameterValues):
networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;
```

- [ ] **Step 2: Build lib to verify types compile**

Run: `npm run build:lib`
Expected: Clean compilation with no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/types/stack-templates.ts
git commit -m "feat: add networkTypeDefaults to stack template version types"
```

---

### Task 2: Add networkTypeDefaults to Prisma Schema & Template Loader

**Files:**
- Modify: `server/prisma/schema.prisma:1320-1347` (StackTemplateVersion model)
- Modify: `server/src/services/stacks/template-file-loader.ts:54-66` (templateFileSchema)
- Modify: `server/src/services/stacks/template-file-loader.ts:74-101` (LoadedTemplate)

- [ ] **Step 1: Add networkTypeDefaults to StackTemplateVersion Prisma model**

In `server/prisma/schema.prisma`, find the `StackTemplateVersion` model and add after `defaultParameterValues`:

```prisma
networkTypeDefaults Json    @default("{}")  // Record<EnvironmentNetworkType, Record<string, StackParameterValue>>
```

- [ ] **Step 2: Add networkTypeDefaults to template file schema**

In `server/src/services/stacks/template-file-loader.ts`, add to `templateFileSchema` (line ~65, before `services`):

```typescript
networkTypeDefaults: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).optional(),
```

- [ ] **Step 3: Add networkTypeDefaults to LoadedTemplate interface**

In the same file, add to the `LoadedTemplate` interface's `definition` object (line ~85, after `parameters`):

```typescript
networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;
```

And add the import if not already present:

```typescript
import type { StackParameterValue } from "@mini-infra/types";
```

Note: `StackParameterValue` is already imported via `stackParameterDefinitionSchema` from `"./schemas"` which references the types. Check the existing imports — if `StackParameterValue` isn't directly imported, use the inline type `string | number | boolean` instead.

- [ ] **Step 4: Add networkTypeDefaults to loadTemplateFromDirectory**

In the `loadTemplateFromDirectory` function, ensure the parsed `networkTypeDefaults` field is included in the returned `LoadedTemplate`. Find where the `definition` object is built (after Zod parsing) and add:

```typescript
networkTypeDefaults: parsed.networkTypeDefaults,
```

inside the `definition` object.

- [ ] **Step 5: Verify template loader parses correctly**

Run: `npx -w server tsc --noEmit`
Expected: Clean compilation.

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma server/src/services/stacks/template-file-loader.ts
git commit -m "feat: add networkTypeDefaults to Prisma schema and template file loader"
```

---

### Task 3: Add networkTypeDefaults to HAProxy Template

**Files:**
- Modify: `server/templates/haproxy/template.json`

- [ ] **Step 1: Add networkTypeDefaults to HAProxy template.json**

In `server/templates/haproxy/template.json`, add after `"parameters"` array and before `"networks"`:

```json
"networkTypeDefaults": {
  "internet": {
    "http-port": 8111,
    "https-port": 8443,
    "stats-port": 8405,
    "dataplane-port": 5556,
    "expose-on-host": false
  }
},
```

Also bump `"builtinVersion"` from `6` to `7` to trigger a sync update.

- [ ] **Step 2: Commit**

```bash
git add server/templates/haproxy/template.json
git commit -m "feat: add network-type defaults to HAProxy template"
```

---

### Task 4: Wire networkTypeDefaults Through Template Service

**Files:**
- Modify: `server/src/services/stacks/stack-template-service.ts:26-34` (UpsertSystemTemplateInput)
- Modify: `server/src/services/stacks/stack-template-service.ts:539-566` (upsertSystemTemplate version create/update)
- Modify: `server/src/services/stacks/stack-template-service.ts:763-853` (createStackFromTemplate)

- [ ] **Step 1: Write failing test for network-type-aware parameter merging**

Create or update test in `server/src/__tests__/stack-template-service.test.ts` (or the most relevant existing test file for stack template instantiation). If no such file exists, add the test to an existing stack test file.

First, check what test files exist:

Run: `ls server/src/__tests__/stack-template*.test.ts 2>/dev/null; ls server/src/__tests__/stack-*.test.ts 2>/dev/null`

Write a test that verifies: when creating a stack from a template that has `networkTypeDefaults` for "internet", and the target environment has `networkType: "internet"`, the merged parameter values include the network-type defaults (not just the base defaults).

The test should mock Prisma to return:
- A template with a current version that has `networkTypeDefaults: { "internet": { "http-port": 8111 } }`
- An environment with `networkType: "internet"`

And assert that the created stack's `parameterValues` includes `"http-port": 8111`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx -w server vitest run src/__tests__/<test-file> --reporter=verbose`
Expected: FAIL — the merge logic doesn't read networkTypeDefaults yet.

- [ ] **Step 3: Add networkTypeDefaults to UpsertSystemTemplateInput**

In `server/src/services/stacks/stack-template-service.ts`, the `UpsertSystemTemplateInput` currently gets its data from `definition: StackDefinition`. The `networkTypeDefaults` lives on the template definition, so it needs to flow through. The `definition` field is typed as `StackDefinition` which doesn't include `networkTypeDefaults`.

The cleanest approach: the `upsertSystemTemplate` method should read `networkTypeDefaults` from the definition's raw data. Since `definition` is cast to `any` at the call site in `builtin-stack-sync.ts` (line 90: `definition: template.definition as any`), the field will be present at runtime.

In `upsertSystemTemplate`, extract it from the input definition and pass it to the version create/update:

```typescript
// In upsertSystemTemplate, after extracting other fields from input (line ~455):
const networkTypeDefaults = (definition as any).networkTypeDefaults ?? {};
```

Then in the `stackTemplateVersion.update` call (line ~539):

```typescript
await tx.stackTemplateVersion.update({
  where: { id: versionId },
  data: {
    parameters: (definition.parameters ?? []) as any,
    defaultParameterValues: buildDefaultParameterValues(
      definition.parameters ?? []
    ) as any,
    networkTypeDefaults: networkTypeDefaults as any,
    networks: definition.networks as any,
    volumes: definition.volumes as any,
    publishedAt: new Date(),
  },
});
```

And in the `stackTemplateVersion.create` call (line ~553):

```typescript
const version = await tx.stackTemplateVersion.create({
  data: {
    templateId: template.id,
    version: builtinVersion,
    status: "published",
    parameters: (definition.parameters ?? []) as any,
    defaultParameterValues: buildDefaultParameterValues(
      definition.parameters ?? []
    ) as any,
    networkTypeDefaults: networkTypeDefaults as any,
    networks: definition.networks as any,
    volumes: definition.volumes as any,
    publishedAt: new Date(),
  },
});
```

- [ ] **Step 4: Update createStackFromTemplate to merge network-type defaults**

In `createStackFromTemplate` (line ~792), after reading `paramDefs` and `defaultValues`, add the network-type merge:

```typescript
const version = template.currentVersion;
const paramDefs = version.parameters as unknown as StackParameterDefinition[];
const defaultValues = version.defaultParameterValues as unknown as Record<
  string,
  StackParameterValue
>;

// Look up environment networkType if environment-scoped
let networkDefaults: Record<string, StackParameterValue> = {};
if (input.environmentId) {
  const env = await this.prisma.environment.findUnique({
    where: { id: input.environmentId },
    select: { networkType: true },
  });
  if (env) {
    const ntDefaults = version.networkTypeDefaults as unknown as Record<string, Record<string, StackParameterValue>> | null;
    networkDefaults = ntDefaults?.[env.networkType] ?? {};
  }
}

// Merge: definition defaults → network-type defaults → user overrides
const mergedValues = mergeParameterValues(
  paramDefs,
  { ...defaultValues, ...networkDefaults, ...(input.parameterValues ?? {}) }
);
```

- [ ] **Step 5: Run tests to verify the new test passes**

Run: `npx -w server vitest run src/__tests__/<test-file> --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/services/stacks/stack-template-service.ts server/src/__tests__/<test-file>
git commit -m "feat: wire networkTypeDefaults through template service and merge during instantiation"
```

---

### Task 5: Update builtin-stack-sync to Use networkTypeDefaults

**Files:**
- Modify: `server/src/services/stacks/builtin-stack-sync.ts:81-103` (syncBuiltinStacks env loop)
- Modify: `server/src/services/stacks/builtin-stack-sync.ts:111-156` (syncBuiltinStacksForEnvironment)
- Modify: `server/src/services/stacks/builtin-stack-sync.ts:163-171` (delete getEnvironmentParameterOverrides)
- Modify: `server/src/services/stacks/builtin-stack-sync.ts:178-260` (syncStackFromTemplate)

- [ ] **Step 1: Remove getEnvironmentParameterOverrides and update callers**

Delete the `getEnvironmentParameterOverrides` function (lines 158-171).

In `syncBuiltinStacks` (lines 81-103), the env loop currently calls:
```typescript
const overrides = getEnvironmentParameterOverrides(template.name, env.networkType);
await syncStackFromTemplate(prisma, templateId, template, env.id, log, overrides);
```

Change to pass `networkType` instead of overrides:
```typescript
await syncStackFromTemplate(prisma, templateId, template, env.id, log, env.networkType);
```

In `syncBuiltinStacksForEnvironment` (lines 136-148), change similarly:
```typescript
// Remove: const overrides = getEnvironmentParameterOverrides(template.name, networkType);
await syncStackFromTemplate(prisma, templateId, template, environmentId, log, networkType);
```

- [ ] **Step 2: Update syncStackFromTemplate to read networkTypeDefaults from template**

Change the function signature from:
```typescript
async function syncStackFromTemplate(
  prisma: PrismaClient,
  templateId: string,
  template: LoadedTemplate,
  environmentId: string | null,
  log: ReturnType<typeof servicesLogger>,
  parameterOverrides: Record<string, StackParameterValue> = {}
): Promise<void>
```

To:
```typescript
async function syncStackFromTemplate(
  prisma: PrismaClient,
  templateId: string,
  template: LoadedTemplate,
  environmentId: string | null,
  log: ReturnType<typeof servicesLogger>,
  networkType: string = "local"
): Promise<void>
```

Then compute `parameterOverrides` from the template's `networkTypeDefaults`:

```typescript
const { definition } = template;
const networkTypeDefaults = definition.networkTypeDefaults ?? {};
const parameterOverrides = networkTypeDefaults[networkType] ?? {};
```

The rest of the function already uses `parameterOverrides` correctly — both in the create path (line 196: `mergeParameterValues(paramDefs, parameterOverrides)`) and the update path (line 247-257).

- [ ] **Step 3: Verify compilation**

Run: `npx -w server tsc --noEmit`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/stacks/builtin-stack-sync.ts
git commit -m "refactor: replace hardcoded parameter overrides with template networkTypeDefaults"
```

---

### Task 6: Create Database Migration

**Files:**
- Create: `server/prisma/migrations/<timestamp>_add_network_type_defaults_remove_env_services/migration.sql`

- [ ] **Step 1: Generate migration**

Run: `npx -w server prisma migrate dev --name add_network_type_defaults_remove_env_services`

This should:
1. Add `networkTypeDefaults` column (JSON, default `'{}'`) to `stack_template_versions`
2. Drop the `environment_services` table

If Prisma auto-detects both changes correctly, review the generated SQL. If it doesn't detect the table drop (because we haven't removed the model from schema yet), we'll handle that in the next task.

- [ ] **Step 2: Verify migration applied**

Run: `npx -w server prisma migrate status`
Expected: All migrations applied, no drift.

- [ ] **Step 3: Add data migration for existing HAProxy template versions**

Check the generated migration SQL. If it doesn't include a data migration to populate `networkTypeDefaults` on existing HAProxy template versions, add this SQL at the end of the migration file:

```sql
-- Populate networkTypeDefaults for existing HAProxy template versions
UPDATE stack_template_versions
SET networkTypeDefaults = '{"internet":{"http-port":8111,"https-port":8443,"stats-port":8405,"dataplane-port":5556,"expose-on-host":false}}'
WHERE id IN (
  SELECT stv.id FROM stack_template_versions stv
  JOIN stack_templates st ON stv.templateId = st.id
  WHERE st.name = 'haproxy' AND st.source = 'system'
);
```

If you added SQL, re-apply:

Run: `npx -w server prisma migrate dev`

- [ ] **Step 4: Regenerate Prisma client**

Run: `npx -w server prisma generate`

- [ ] **Step 5: Commit**

```bash
git add server/prisma/migrations/ server/prisma/schema.prisma
git commit -m "feat: add networkTypeDefaults column and drop environment_services table"
```

---

### Task 7: Create HAProxy Stack Lookup Helper

**Files:**
- Modify: `server/src/routes/environments.ts` (add helper near top of file)

- [ ] **Step 1: Write the helper function**

Add near the top of `server/src/routes/environments.ts` (after imports), or in a shared location if the same helper is needed across multiple route files. Since 4 route files need this, create a small shared helper.

Create a utility function in `server/src/routes/environments.ts` first, then extract if needed:

```typescript
import { PrismaClient } from '@prisma/client';

/**
 * Find the HAProxy stack for an environment, returning the stack with its services.
 * Returns null if no HAProxy stack exists.
 */
async function findHAProxyStack(prisma: PrismaClient, environmentId: string) {
  return prisma.stack.findFirst({
    where: {
      environmentId,
      name: 'haproxy',
      status: { not: 'removed' },
    },
    include: {
      services: true,
    },
  });
}
```

Since `haproxy-backends.ts`, `haproxy-frontends.ts`, and `manual-haproxy-frontends.ts` also need this, put it in a shared location. Check if there's already a shared route utilities file. If not, add it to each file inline — 3 lines of Prisma query isn't worth a new file.

- [ ] **Step 2: Commit**

```bash
git add server/src/routes/environments.ts
git commit -m "feat: add findHAProxyStack helper for stack-based HAProxy lookup"
```

---

### Task 8: Replace HAProxy Lookups in Route Files

**Files:**
- Modify: `server/src/routes/environments.ts` — HAProxy status/remediation/migration routes
- Modify: `server/src/routes/haproxy-backends.ts:73-115` (getHAProxyClient)
- Modify: `server/src/routes/haproxy-frontends.ts:195-224`
- Modify: `server/src/routes/manual-haproxy-frontends.ts:125-170` (getHAProxyClient)

- [ ] **Step 1: Update haproxy-backends.ts getHAProxyClient**

The current code (lines 73-115) does:
```typescript
const environment = await prisma.environment.findUnique({
  where: { id: environmentId },
  include: {
    services: { where: { serviceName: "haproxy" } },
  },
});
const haproxyService = environment.services.find((s) => s.serviceName === "haproxy");
```

Replace with:
```typescript
const environment = await prisma.environment.findUnique({
  where: { id: environmentId },
});
if (!environment) {
  throw new Error(`Environment not found: ${environmentId}`);
}

const haproxyStack = await prisma.stack.findFirst({
  where: {
    environmentId,
    name: 'haproxy',
    status: { not: 'removed' },
  },
  include: { services: true },
});
if (!haproxyStack) {
  throw new Error(`HAProxy stack not found for environment: ${environmentId}`);
}
```

Then update the container lookup logic. The current code finds the HAProxy container by the service's container config. With stacks, the container name follows the pattern `{stackName}-{serviceName}` (e.g., `haproxy-haproxy`). Check how the existing code finds the container — it likely uses Docker labels or container name. Update accordingly using the stack service's `serviceName` to find the container.

- [ ] **Step 2: Update manual-haproxy-frontends.ts getHAProxyClient**

Apply the same pattern as Step 1. The code at lines 125-170 has the same structure.

- [ ] **Step 3: Update haproxy-frontends.ts**

The code at lines 195-224 has a similar lookup. Apply the same stack-based replacement.

- [ ] **Step 4: Update environments.ts HAProxy routes**

In `server/src/routes/environments.ts`, find all places that do `environment.services.find(s => s.serviceName === 'haproxy')` or `environment.services.some(s => s.serviceName === 'haproxy')` and replace with stack-based lookups.

For the `some` checks (used to verify HAProxy exists before proceeding), replace with:
```typescript
const haproxyStack = await prisma.stack.findFirst({
  where: { environmentId: id, name: 'haproxy', status: { not: 'removed' } },
});
if (!haproxyStack) {
  return res.status(400).json({ success: false, error: 'No HAProxy stack found for this environment' });
}
```

- [ ] **Step 5: Remove `include: { services: true }` from Prisma queries that only needed it for HAProxy lookup**

Search `environments.ts` for any `include: { services: true }` that was only there for the HAProxy lookup and remove it (keep includes for networks/volumes/stacks as needed).

- [ ] **Step 6: Verify compilation**

Run: `npx -w server tsc --noEmit`
Expected: Clean compilation.

- [ ] **Step 7: Run existing HAProxy tests to check for regressions**

Run: `npx -w server vitest run --reporter=verbose`
Expected: Existing tests that don't depend on environment.services should pass. Tests that do will be fixed in Task 10.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/haproxy-backends.ts server/src/routes/haproxy-frontends.ts server/src/routes/manual-haproxy-frontends.ts server/src/routes/environments.ts
git commit -m "refactor: replace environment.services HAProxy lookups with stack-based queries"
```

---

### Task 9: Remove Environment Service Endpoints and Routes

**Files:**
- Modify: `server/src/routes/environments.ts` — remove service endpoints

- [ ] **Step 1: Remove service API endpoints**

In `server/src/routes/environments.ts`, delete these route handlers entirely:

1. `GET /:id/services` (around line 290)
2. `POST /:id/services` (around line 315)
3. `GET /services/available` (around line 364)
4. `GET /services/available/:serviceType` (around line 380)

Also remove any imports used only by these routes:
- `ServiceRegistry` import
- `portUtils` / `PortUtils` import
- `addServiceToEnvironment` references

- [ ] **Step 2: Remove serviceCount from environment list response**

Find where `serviceCount: environment.services.length` is returned (around line 137) and remove it.

- [ ] **Step 3: Verify compilation**

Run: `npx -w server tsc --noEmit`
Expected: Clean compilation (may have errors from other files still referencing deleted code — those are addressed in next tasks).

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/environments.ts
git commit -m "refactor: remove environment service API endpoints"
```

---

### Task 10: Remove Environment Service Backend Code

**Files:**
- Delete: `server/src/services/environment/service-recovery.ts`
- Delete: `server/src/services/environment/environment-health-scheduler.ts`
- Delete: `server/src/services/environment/service-registry.ts`
- Delete: `server/src/services/port-utils.ts`
- Modify: `server/src/services/environment/environment-manager.ts` — remove service methods
- Modify: `server/src/services/environment/index.ts` — remove exports

- [ ] **Step 1: Delete service-recovery.ts, environment-health-scheduler.ts, service-registry.ts, port-utils.ts**

```bash
rm server/src/services/environment/service-recovery.ts
rm server/src/services/environment/environment-health-scheduler.ts
rm server/src/services/environment/service-registry.ts
rm server/src/services/port-utils.ts
```

- [ ] **Step 2: Update environment/index.ts**

Change from:
```typescript
export { EnvironmentManager } from "./environment-manager";
export { EnvironmentHealthScheduler } from "./environment-health-scheduler";
export { EnvironmentValidationService, type HAProxyEnvironmentContext, type EnvironmentValidationResult } from "./environment-validation";
export { ServiceRecoveryManager } from "./service-recovery";
export { ServiceRegistry, type ServiceTypeDefinition } from "./service-registry";
```

To:
```typescript
export { EnvironmentManager } from "./environment-manager";
export { EnvironmentValidationService, type HAProxyEnvironmentContext, type EnvironmentValidationResult } from "./environment-validation";
```

- [ ] **Step 3: Remove service methods from environment-manager.ts**

Delete these methods:
- `addServiceToEnvironment()` (around line 600)
- `addServicesToEnvironment()` (around line 585)

In `deleteEnvironment()` (around line 363), remove the block that iterates `environment.services` to stop each service (around lines 414-453). Keep the rest of the deletion logic (networks, volumes, stacks, Prisma delete).

Also remove the `include: { services: true }` from any Prisma queries in `deleteEnvironment()` and `getEnvironmentById()` if `services` was the only reason for the include. Keep includes for networks, volumes, stacks.

- [ ] **Step 4: Fix any imports referencing deleted modules**

Search for imports of the deleted modules across the server codebase:

Run: `grep -r "service-recovery\|ServiceRecoveryManager\|environment-health-scheduler\|EnvironmentHealthScheduler\|service-registry\|ServiceRegistry\|port-utils\|PortUtils" server/src/ --include="*.ts" -l`

Update or remove each import. Common locations:
- Server startup file (e.g., `server/src/index.ts` or `server/src/app.ts`) — remove scheduler/recovery initialization
- Route files — remove ServiceRegistry and PortUtils imports (already handled in Task 9 for environments.ts)

- [ ] **Step 5: Verify compilation**

Run: `npx -w server tsc --noEmit`
Expected: Clean compilation. Fix any remaining references.

- [ ] **Step 6: Commit**

```bash
git add -A server/src/services/environment/ server/src/services/port-utils.ts
git commit -m "refactor: remove environment service backend code (recovery, health scheduler, registry, port-utils)"
```

---

### Task 11: Remove EnvironmentService from Prisma Schema and Types

**Files:**
- Modify: `server/prisma/schema.prisma` — remove EnvironmentService model and services relation
- Modify: `lib/types/environments.ts` — remove EnvironmentService interface and services from Environment

- [ ] **Step 1: Remove EnvironmentService model from Prisma schema**

In `server/prisma/schema.prisma`, delete the entire `EnvironmentService` model (around lines 389-409).

In the `Environment` model, remove the `services` relation line:
```prisma
services    EnvironmentService[]  // DELETE THIS LINE
```

- [ ] **Step 2: Update shared types**

In `lib/types/environments.ts`:

Remove the `EnvironmentService` interface entirely (lines 20-38).

Remove `services: EnvironmentService[]` from the `Environment` interface (line 13).

Remove the `ServiceStatus` and `ApplicationServiceHealthStatus` import if they are only used by `EnvironmentService`:
```typescript
// Check if this import is still needed:
import { ServiceStatus, ApplicationServiceHealthStatus } from './services';
```

- [ ] **Step 3: Regenerate Prisma client**

Run: `npx -w server prisma generate`

Note: The migration from Task 6 already dropped the `environment_services` table. If the schema model removal triggers a new migration prompt, just run `npx -w server prisma migrate dev --name remove_environment_service_model` to keep things clean.

- [ ] **Step 4: Build lib to verify types compile**

Run: `npm run build:lib`
Expected: Clean compilation.

- [ ] **Step 5: Commit**

```bash
git add server/prisma/schema.prisma lib/types/environments.ts
git commit -m "refactor: remove EnvironmentService model and types"
```

---

### Task 12: Remove Environment Service Frontend Code

**Files:**
- Delete: `client/src/components/environments/service-add-dialog.tsx`
- Modify: `client/src/components/environments/environment-card.tsx` — remove service health display
- Modify: `client/src/components/environments/environment-status.tsx` — check if ServiceHealth is used elsewhere; if not, remove
- Modify: `client/src/components/environments/index.ts` — remove service exports
- Modify: `client/src/hooks/use-environments.ts` — remove service hooks
- Modify: `client/src/app/environments/[id]/page.tsx` — remove Add Service button and service display

- [ ] **Step 1: Delete service-add-dialog.tsx**

```bash
rm client/src/components/environments/service-add-dialog.tsx
```

- [ ] **Step 2: Update index.ts barrel exports**

In `client/src/components/environments/index.ts`, remove:
```typescript
export { ServiceHealth } from "./environment-status";
export { ServiceAddDialog } from "./service-add-dialog";
```

- [ ] **Step 3: Remove service health display from environment-card.tsx**

Remove the service health badge section that shows `{healthyServices}/{totalServices}` and the individual service list. Remove the `ApplicationServiceHealthStatusValues` import if no longer needed.

The card should still show environment info (name, type, networkType, networks, stacks) — just remove the service-specific sections.

- [ ] **Step 4: Clean up environment-status.tsx**

Check if `ServiceHealth` component is imported anywhere else in the codebase:

Run: `grep -r "ServiceHealth" client/src/ --include="*.tsx" --include="*.ts" -l`

If only used in `environment-card.tsx` (which we just cleaned) and `index.ts` (which we just cleaned), remove the `ServiceHealth` component from `environment-status.tsx`. If the file becomes empty, delete it. If it has other exports, keep those.

- [ ] **Step 5: Remove service hooks from use-environments.ts**

In `client/src/hooks/use-environments.ts`, remove:
- `fetchAvailableServices()` function
- `fetchServiceTypeMetadata()` function
- `addServiceToEnvironment()` function
- Any `useQuery` / `useMutation` hooks that wrap these functions (e.g., `useAvailableServices`, `useServiceTypeMetadata`, `useAddServiceToEnvironment`)

- [ ] **Step 6: Update environment-delete-dialog.tsx**

In `client/src/components/environments/environment-delete-dialog.tsx`:
- Remove warnings about running services (e.g., `environment.services.some(...)`)
- Remove the service name list shown in the delete confirmation
- Keep the rest of the delete dialog logic unchanged

- [ ] **Step 7: Update environment detail page**

In `client/src/app/environments/[id]/page.tsx`:
- Remove the "Add Service" button and its `ServiceAddDialog` usage
- Remove service health display section
- Remove imports for `ServiceAddDialog`, `ServiceHealth`, and related types

- [ ] **Step 8: Check for any other frontend references**

Run: `grep -r "EnvironmentService\|ServiceAddDialog\|ServiceHealth\|services\.find\|services\.length\|services\.map\|services\.filter\|services\.some" client/src/ --include="*.tsx" --include="*.ts" -l`

Fix any remaining references.

- [ ] **Step 9: Verify frontend builds**

Run: `npm run build -w client`
Expected: Clean build with no errors.

- [ ] **Step 10: Commit**

```bash
git add -A client/src/
git commit -m "refactor: remove environment service frontend code"
```

---

### Task 13: Update Tests

**Files:**
- Delete: `server/src/__tests__/service-registry.test.ts`
- Delete: `server/src/__tests__/port-utils.test.ts`
- Modify: `server/src/__tests__/environment-api.test.ts` — remove service endpoint tests
- Modify: `server/src/__tests__/environment-manager.test.ts` — remove service method tests

- [ ] **Step 1: Delete obsolete test files**

```bash
rm server/src/__tests__/service-registry.test.ts
rm server/src/__tests__/port-utils.test.ts
```

- [ ] **Step 2: Update environment-api.test.ts**

Remove:
- The `mockServiceRegistry` mock (line 15 area)
- The `vi.mock('../services/environment/service-registry')` mock (line 69 area)
- The `addServiceToEnvironment` mock function reference
- The `describe('GET /api/environments/:id/services')` test block (line 475 area)
- The `describe('POST /api/environments/:id/services')` test block (line 500 area)
- Any test that references `services` in the mock environment data — update the mock to not include `services` array
- Remove `services` from mock environment objects (e.g., line 106 area)

Keep all other environment tests (CRUD, networks, volumes, HAProxy status routes).

For HAProxy-related tests that previously checked `environment.services.find(...)`, update them to mock the stack lookup instead.

- [ ] **Step 3: Update environment-manager.test.ts**

Remove test cases for:
- `addServiceToEnvironment()`
- `addServicesToEnvironment()`
- Service-related logic in `deleteEnvironment()` (update the test to not mock service stopping)

Update mock environment data to not include `services` array.

- [ ] **Step 4: Run all server tests**

Run: `npm test -w server`
Expected: All tests pass. Fix any failures.

- [ ] **Step 5: Commit**

```bash
git add -A server/src/__tests__/
git commit -m "test: update tests for environment service removal"
```

---

### Task 14: Final Verification

- [ ] **Step 1: Build everything**

Run: `npm run build`
Expected: Clean build across lib, server, and client.

- [ ] **Step 2: Run all tests**

Run: `npm test -w server`
Expected: All tests pass.

- [ ] **Step 3: Verify no stale references remain**

Run: `grep -r "EnvironmentService\|environment_services\|ServiceRecoveryManager\|EnvironmentHealthScheduler\|ServiceRegistry\|portUtils\|PortUtils\|addServiceToEnvironment\|addServicesToEnvironment" server/src/ lib/ client/src/ --include="*.ts" --include="*.tsx" -l`

Expected: No results (or only in migration SQL files and this plan/spec).

- [ ] **Step 4: Verify Prisma schema is clean**

Run: `npx -w server prisma validate`
Expected: Clean validation.

- [ ] **Step 5: Commit any final fixes**

If any issues were found and fixed:
```bash
git add -A
git commit -m "fix: resolve remaining references from environment service removal"
```
