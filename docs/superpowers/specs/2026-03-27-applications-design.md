# Applications Feature Design

## Overview

Replace the user-facing "Deployments" concept with "Applications." Applications are user-created stacks (`source = "user"`) that leverage the existing stack infrastructure for definition and the deployment orchestrator for execution of StatelessWeb services. The deployment backend remains intact but is no longer exposed in the UI.

## Database Changes

Add a `source` field to the `Stack` model:

```prisma
source  String  @default("system")  // "system" | "user"
```

- Index on `source` for efficient filtering.
- Existing stacks default to `"system"` via migration.
- No other schema changes.

## API Changes

### Existing stack endpoints — no new route files

All application CRUD and operations use existing `/api/stacks` routes. The frontend passes `source: "user"` on creation and filters by `source` when listing.

Existing host/environment stack views add `source: "system"` to their queries so user stacks don't appear.

### New endpoint: Import deployment

```
POST /api/stacks/import-deployment/:configId
```

Converts a `DeploymentConfiguration` into a single-service user stack.

## Import Mapping

When importing a DeploymentConfiguration, map to a single-service user stack:

| DeploymentConfiguration | Stack / StackService |
|---|---|
| `applicationName` | Stack `name` |
| `dockerImage` | StackService `dockerImage` |
| `dockerTag` | StackService `dockerTag` |
| `dockerRegistry` | Prepended to `dockerImage` (e.g., `ghcr.io/myapp`) |
| `containerConfig.ports` | StackService `containerConfig.ports` |
| `containerConfig.volumes` | StackService `containerConfig.mounts` + Stack `volumes` |
| `containerConfig.environment` | StackService `containerConfig.env` (array to object) |
| `containerConfig.labels` | StackService `containerConfig.labels` |
| `containerConfig.networks` | StackService `containerConfig.joinNetworks` |
| `healthCheckConfig` | StackService `containerConfig.healthcheck` |
| `rollbackConfig` | Stored in Stack `parameterValues` as `rollbackEnabled`, `rollbackMaxWaitTime`, `rollbackKeepOldContainer` |
| `hostname`, `listeningPort`, `enableSsl`, `tlsCertificateId` | StackService `routing` |
| `environmentId` | Stack `environmentId` |

Service type: `StatelessWeb` if routing/hostname is configured, otherwise `Stateful`.

## Frontend

### New pages

- **`/applications`** — List all user stacks. Shows name, status, service count, last deployed time. Actions per row: Deploy, Stop, Edit, Delete.
- **`/applications/new`** — Create a new application. Reuses the stack creation form (service definition with image, ports, volumes, env vars, networks, routing) but pre-sets `source: "user"`.
- **`/applications/[id]`** — Edit an existing application. Same form, loaded with current stack data.

### Import deployment flow

An "Import Deployment" button on the `/applications` page opens a dialog listing existing DeploymentConfigurations. User picks one, hits import, the import endpoint is called, and the new application appears in the list.

### Navigation changes

Replace the "Deployments" entry in the sidebar with "Applications." Same position in the Operations panel. The `/deployments` routes remain in the codebase but are no longer linked from the nav.

### Existing stack views

Host page and environment pages filter their stack lists to `source: "system"` so user stacks don't appear.

## Deployment execution

When a user deploys an application:
1. The stack reconciler applies the stack (creates/updates containers).
2. For `StatelessWeb` services, the deployment orchestrator handles zero-downtime deploys (health checks, rollback, traffic switching via HAProxy).
3. `Stateful` services are applied directly by the stack reconciler without orchestration.

## What stays unchanged

- All deployment backend tables, orchestrator, and API routes remain intact.
- Existing `/api/stacks` routes continue working.
- Stack templates, reconciler, and all stack infrastructure unchanged.
- Socket.IO events for stack operations unchanged.
