# Stack Templates — Design & Implementation Plan

## Overview

Move stack definitions from in-code TypeScript objects (HAProxy, monitoring) into a proper template system stored in the database. Templates act as reusable blueprints; Stacks are instantiations of those blueprints with specific parameter values in specific environments.

Templates support multiple sources — `system` (shipped with the app) and `user` (created by users) — with room for more later (e.g. `marketplace`, `imported`).

## Data Model

### Entity Relationships

```
StackTemplate
├── currentVersion? ──→ StackTemplateVersion (latest published)
├── draftVersion?   ──→ StackTemplateVersion (in-progress draft)
├── versions[]      ──→ StackTemplateVersion[] (full history)
│   ├── services[]  ──→ StackTemplateService[]
│   └── configFiles[] → StackTemplateConfigFile[]
└── stacks[]        ──→ Stack[] (instantiated stacks)
```

### StackTemplate

Identity/metadata record. One row per template, never duplicated per version.

| Column | Type | Notes |
|---|---|---|
| `id` | String (cuid) | PK |
| `name` | String | Unique slug, e.g. `haproxy`, `monitoring`, `my-api` |
| `displayName` | String | Human-friendly name |
| `description` | String? | |
| `source` | Enum: `system`, `user` | Extensible later |
| `scope` | Enum: `host`, `environment` | Whether template produces host-scoped or env-scoped stacks |
| `category` | String? | For UI grouping: `infrastructure`, `database`, `application`, etc. |
| `isArchived` | Boolean | Soft-delete; archived templates can't create new stacks |
| `currentVersionId` | String? | FK → StackTemplateVersion (latest published, null until first publish) |
| `draftVersionId` | String? | FK → StackTemplateVersion (in-progress draft, null when clean) |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |
| `createdById` | String? | FK → User (null for system) |

**Unique constraint**: `(name, source)`

### StackTemplateVersion

Immutable snapshot per published version. Each publish creates a new row. Full history is preserved.

| Column | Type | Notes |
|---|---|---|
| `id` | String (cuid) | PK |
| `templateId` | String | FK → StackTemplate |
| `version` | Int | Sequential: 1, 2, 3... Draft uses 0. |
| `status` | Enum: `draft`, `published`, `archived` | |
| `notes` | String? | Changelog for this version |
| `parameters` | Json | `StackParameterDefinition[]` |
| `defaultParameterValues` | Json | `Record<string, StackParameterValue>` |
| `networks` | Json | `StackNetwork[]` |
| `volumes` | Json | `StackVolume[]` |
| `publishedAt` | DateTime? | |
| `createdAt` | DateTime | |
| `createdById` | String? | FK → User |

**Unique constraint**: `(templateId, version)`

### StackTemplateService

Service definition hanging off a version. Copied from here into `StackService` when a stack is instantiated.

| Column | Type | Notes |
|---|---|---|
| `id` | String (cuid) | PK |
| `versionId` | String | FK → StackTemplateVersion |
| `serviceName` | String | |
| `serviceType` | Enum: `Stateful`, `StatelessWeb` | Reuses existing `StackServiceType` |
| `dockerImage` | String | Can contain `{{params.*}}` templates |
| `dockerTag` | String | |
| `containerConfig` | Json | `StackContainerConfig` |
| `initCommands` | Json? | `StackInitCommand[]` |
| `dependsOn` | Json | `string[]` |
| `order` | Int | Execution order |
| `routing` | Json? | `StackServiceRouting` (StatelessWeb only) |

**Unique constraint**: `(versionId, serviceName)`

### StackTemplateConfigFile

Config files stored separately from services, hanging off a version.

| Column | Type | Notes |
|---|---|---|
| `id` | String (cuid) | PK |
| `versionId` | String | FK → StackTemplateVersion |
| `serviceName` | String | Which service this config belongs to |
| `fileName` | String | e.g. `haproxy.cfg`, `prometheus.yml` |
| `volumeName` | String | Target volume |
| `mountPath` | String | Path inside the volume |
| `content` | String | Full file content, supports `{{template}}` variables |
| `permissions` | String? | e.g. `644` |
| `owner` | String? | e.g. `root:root` |

**Unique constraint**: `(versionId, serviceName, volumeName, mountPath)`

### Changes to Existing Stack Table

| Column | Type | Notes |
|---|---|---|
| `templateId` | String? | FK → StackTemplate (null for legacy/manual stacks) |
| `templateVersion` | Int? | Which template version this stack was created/synced from |

The Stack still owns its own services (the instantiated copy). The `templateVersion` enables detecting when the template has been updated and offering to re-sync.

## Versioning Lifecycle

### System Templates

- Created and published in one step during startup seeding
- `hasDraft` is always false; no draft step
- Version number equals `builtinVersion` from the TypeScript definition (currently 2 for monitoring, 3 for haproxy)
- On code updates: seed script bumps version, sets `publishedAt`, creates new `StackTemplateVersion` row
- Existing stacks linked to the template get `status: 'pending'` when template version advances

### User Templates

1. **Create** → `StackTemplate` row + `StackTemplateVersion` with `version: 0, status: draft` → set `draftVersionId`
2. **Edit** → modify services/config files on the draft version freely
3. **Publish** → set draft's `status: published`, assign `version: MAX(existing) + 1`, set `publishedAt` → move `draftVersionId` to `currentVersionId`, clear `draftVersionId`
4. **New edit** → clone current version's services + config files into a new draft row (`version: 0, status: draft`) → set `draftVersionId`
5. **Publish again** → draft becomes next version number, previous published versions remain for history

### State Machine Invariants

- A template can have at most one draft version at a time
- `publishDraft`: transitions draft → published, increments version, sets `publishedAt`, updates `currentVersionId`, clears `draftVersionId` (all in a transaction)
- `discardDraft`: deletes the draft `StackTemplateVersion` row (cascades to services/configFiles), clears `draftVersionId`
- System templates never have a draft; `upsertSystemTemplate` writes directly to published versions

## Stack-Template Relationship

### Creating a Stack from a Template

1. User picks a template → API reads `currentVersion` with services and configFiles
2. Services are copied into new `StackService` rows; config files are merged into each service's `configFiles` JSON
3. User provides `parameterValues` (template supplies defaults via `defaultParameterValues`)
4. Stack stores `templateId` + `templateVersion` for lineage tracking
5. Normal plan/apply flow works unchanged from here

### Template Update Detection

- When `stack.templateVersion < template.currentVersion.version`, the API surfaces `templateUpdateAvailable: true` on `StackInfo`
- User can choose to sync (re-copy services from template, preserving parameter values) or ignore
- System templates auto-sync on startup (current behavior preserved)
- User templates require manual sync (don't silently change running stacks)

### Multiple Instances

The design supports multiple stacks from the same template in one environment. No enforcement of one-per-template-per-environment (though currently HAProxy only needs one per environment).

## API Routes

New routes at `/api/stack-templates`:

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/` | `stacks:read` | List templates (query: `source`, `scope`, `includeArchived`) |
| GET | `/:templateId` | `stacks:read` | Get template with currentVersion |
| GET | `/:templateId/versions` | `stacks:read` | List all versions for a template |
| GET | `/:templateId/versions/:versionId` | `stacks:read` | Get specific version with services + configFiles |
| POST | `/` | `stacks:write` | Create user template (creates draft version 0) |
| PATCH | `/:templateId` | `stacks:write` | Update template metadata (displayName, description, category) |
| POST | `/:templateId/draft` | `stacks:write` | Create or replace draft version |
| POST | `/:templateId/publish` | `stacks:write` | Publish draft → new version |
| DELETE | `/:templateId/draft` | `stacks:write` | Discard draft |
| DELETE | `/:templateId` | `stacks:write` | Archive template (soft delete; blocked if stacks linked) |
| POST | `/:templateId/instantiate` | `stacks:write` | Create Stack from template |

System templates are read-only via the API — write operations return 403.

## Migration from Current Builtin System

1. `builtin-stack-sync.ts` is rewritten to use `StackTemplateService.upsertSystemTemplate` + `syncStackFromTemplate`
2. Same exported function signatures (`syncBuiltinStacks`, `syncBuiltinStacksForEnvironment`) — `server.ts` unchanged
3. Existing stacks with `builtinVersion IS NOT NULL` get backfilled with `templateId` + `templateVersion` on first startup
4. The `builtinVersion` column on `Stack` is deprecated in place (not removed in this phase)
5. TypeScript builtin definition files (`haproxy.ts`, `monitoring.ts`) remain as seed data sources

## Key Files

### New Files
- `lib/types/stack-templates.ts` — shared TypeScript types
- `server/src/services/stacks/stack-template-service.ts` — template CRUD + lifecycle
- `server/src/services/stacks/stack-template-schemas.ts` — Zod validation schemas
- `server/src/routes/stack-templates.ts` — API routes

### Modified Files
- `server/prisma/schema.prisma` — new models + Stack FK additions
- `lib/types/stacks.ts` — add `templateId`, `templateVersion`, `templateUpdateAvailable` to interfaces
- `lib/types/index.ts` — export new types
- `server/src/services/stacks/builtin-stack-sync.ts` — rewrite to use templates
- `server/src/services/stacks/builtin/types.ts` — add `displayName` to interface
- `server/src/services/stacks/builtin/haproxy.ts` — add `displayName`
- `server/src/services/stacks/builtin/monitoring.ts` — add `displayName`
- `server/src/services/stacks/utils.ts` — update `serializeStack` for new fields
- `server/src/routes/stacks.ts` — include template relation in queries
- `server/src/services/stacks/stack-reconciler.ts` — populate `templateUpdateAvailable` on StackPlan
- `server/src/app.ts` — register new route

---

## Implementation Phases

### Phase 1 — Schema & Types

1. Add new enums to `schema.prisma`: `StackTemplateSource`, `StackTemplateScope`, `StackTemplateVersionStatus`
2. Add new models: `StackTemplate`, `StackTemplateVersion`, `StackTemplateService`, `StackTemplateConfigFile`
3. Add `templateId` + `templateVersion` nullable FKs to existing `Stack` model
4. Run `npx prisma migrate dev --name add_stack_templates`
5. Create `lib/types/stack-templates.ts` with all shared types
6. Add `templateId`, `templateVersion`, `templateUpdateAvailable` to `Stack`, `StackInfo`, `StackPlan` in `lib/types/stacks.ts`
7. Export from `lib/types/index.ts`
8. Verify lib compiles

### Phase 2 — Template Service

1. Create `stack-template-schemas.ts` with Zod validation schemas
2. Create `stack-template-service.ts` with the `StackTemplateService` class:
   - `upsertSystemTemplate` — idempotent write for builtin sync
   - `createStackFromTemplate` — instantiate a stack from a published template version
   - `listTemplates`, `getTemplate`, `getTemplateVersion`, `getPublishedVersion` — queries
   - `createUserTemplate` — create template with initial draft
   - `updateTemplateMeta` — update displayName, description, category
   - `archiveTemplate` — soft delete
   - `createOrUpdateDraft` — create or replace draft version with services/configFiles
   - `publishDraft` — promote draft to published version
   - `discardDraft` — delete draft version
   - Serialization helpers

### Phase 3 — Rewrite builtin-stack-sync.ts

1. Add `displayName` to `BuiltinStackDefinition` interface and builtin definitions
2. Rewrite `syncBuiltinStacks` and `syncBuiltinStacksForEnvironment` to:
   - Call `StackTemplateService.upsertSystemTemplate` for each builtin
   - Call `syncStackFromTemplate` to create/update Stack rows from template data
3. Backfill existing stacks with `templateId` + `templateVersion`
4. Keep same exported function signatures so `server.ts` needs no changes

### Phase 4 — Update Existing Routes & Utils

1. Update `serializeStack` in `utils.ts` to include `templateId`, `templateVersion`, `templateUpdateAvailable`
2. Update stack queries in `routes/stacks.ts` to include template relation
3. Update `StackReconciler.plan()` to populate `templateUpdateAvailable` on `StackPlan`

### Phase 5 — New Template Routes

1. Create `routes/stack-templates.ts` with all 11 routes
2. Register in `app.ts`
3. System template write protection (403 for mutations on `source: 'system'`)

### Phase 6 — Integration Verification

1. Restart dev server and verify startup sync creates two system templates
2. Verify `GET /api/stack-templates` returns haproxy + monitoring
3. Verify `GET /api/stacks` returns stacks with `templateId`/`templateVersion` populated
4. Test `POST /api/stack-templates/:id/instantiate` creates a linked stack
5. Verify existing plan/apply flows work unchanged
