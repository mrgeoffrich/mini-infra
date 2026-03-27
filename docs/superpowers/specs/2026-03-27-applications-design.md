# Applications Feature Design

## Overview

Replace the user-facing "Deployments" concept with "Applications." An application is a `StackTemplate` with `source = user`. When the user deploys an application, a `Stack` is instantiated from that template and applied. The deployment backend remains intact but is no longer exposed in the UI.

## Database Changes

None. The existing `StackTemplate.source` field (`StackTemplateSource` enum: `system | user`) already provides the distinction. Stacks created from user templates are identified by joining to their template where `source = user`.

## API Changes

### Existing endpoints

All application CRUD uses existing `/api/stack-templates` routes. The frontend filters by `source: "user"` when listing. Deploy/stop uses existing `/api/stacks` routes (apply/stop on the stack instantiated from the template).

Existing host/environment stack views filter out stacks whose template has `source = "user"`.

### New endpoint: Import deployment

```
POST /api/stack-templates/import-deployment/:configId
```

Converts a `DeploymentConfiguration` into a single-service user `StackTemplate`.

## Import Mapping

When importing a DeploymentConfiguration, map to a single-service user stack template:

| DeploymentConfiguration | StackTemplate / StackTemplateService |
|---|---|
| `applicationName` | StackTemplate `name` and `displayName` |
| `dockerImage` | StackTemplateService `dockerImage` |
| `dockerTag` | StackTemplateService `dockerTag` |
| `dockerRegistry` | Prepended to `dockerImage` (e.g., `ghcr.io/myapp`) |
| `containerConfig.ports` | StackTemplateService `containerConfig.ports` |
| `containerConfig.volumes` | StackTemplateService `containerConfig.mounts` + StackTemplateVersion `volumes` |
| `containerConfig.environment` | StackTemplateService `containerConfig.env` (array to object) |
| `containerConfig.labels` | StackTemplateService `containerConfig.labels` |
| `containerConfig.networks` | StackTemplateService `containerConfig.joinNetworks` |
| `healthCheckConfig` | StackTemplateService `containerConfig.healthcheck` |
| `rollbackConfig` | Stored in StackTemplateVersion `defaultParameterValues` as `rollbackEnabled`, `rollbackMaxWaitTime`, `rollbackKeepOldContainer` |
| `hostname`, `listeningPort`, `enableSsl`, `tlsCertificateId` | StackTemplateService `routing` |
| `environmentId` | Stored in StackTemplateVersion `defaultParameterValues` as `environmentId` |

- Template `source` set to `user`.
- Template version created with status `published`.
- Service type: `StatelessWeb` if routing/hostname is configured, otherwise `Stateful`.

## Frontend

### New pages

- **`/applications`** — List all user stack templates. Shows name, status, service count, last deployed time. Actions per row: Deploy, Stop, Edit, Delete.
- **`/applications/new`** — Create a new application (user stack template). Reuses the stack template creation form (service definition with image, ports, volumes, env vars, networks, routing) with `source: "user"` pre-set.
- **`/applications/[id]`** — Edit an existing application (user stack template). Same form, loaded with current template data.

### Import deployment flow

An "Import Deployment" button on the `/applications` page opens a dialog listing existing DeploymentConfigurations. User picks one, hits import, the import endpoint is called, and the new application appears in the list.

### Navigation changes

Replace the "Deployments" entry in the sidebar with "Applications." Same position in the Operations panel. The `/deployments` routes remain in the codebase but are no longer linked from the nav.

### Existing stack views

Host page and environment pages filter out stacks whose template has `source = "user"`.

## Deployment execution

When a user deploys an application:
1. A Stack is instantiated from the user's StackTemplate (or an existing stack is updated if already deployed).
2. The stack reconciler applies the stack (creates/updates containers).
3. For `StatelessWeb` services, the deployment orchestrator handles zero-downtime deploys (health checks, rollback, traffic switching via HAProxy).
4. `Stateful` services are applied directly by the stack reconciler without orchestration.

## What stays unchanged

- All deployment backend tables, orchestrator, and API routes remain intact.
- Existing `/api/stacks` and `/api/stack-templates` routes continue working.
- Stack reconciler and all stack infrastructure unchanged.
- Socket.IO events for stack operations unchanged.
