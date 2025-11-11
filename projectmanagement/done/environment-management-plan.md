# Environment Management Feature Plan

## Goals
- Introduce environments as first-class resources to group Docker networks, volumes, and containers under a named context.
- Allow administrators to classify environments as `prod` or `nonprod` and manage lifecycle actions (create, update metadata, destroy).
- Provide an environment detail view so users can provision and inspect constituent Docker resources from the UI.
- These environments are managed system wide and are NOT per user.

## Assumptions
- Environment records are globally visible to authenticated users; ownership is tracked for auditing but not for access control in this iteration.
- Docker hosts remain single-tenant; resource names must be unique per environment but may coexist across environments by adding environment-specific prefixes/labels.
- Container orchestration stays within the existing Docker APIs (no Compose files); we leverage current services such as `DockerExecutorService` and `ContainerLifecycleManager`.
- Network calls remain synchronous HTTP requests; no websockets are required for the first release.

## Prisma / Database Updates
### New enums
- `EnvironmentType` with values `PROD` and `NONPROD` (default `NONPROD`).
- `EnvironmentStatus` with values such as `PROVISIONING`, `READY`, `UPDATING`, `ERROR`, `DELETING` to reflect lifecycle state.
- `EnvironmentResourceStatus` for per-resource tracking (`CREATING`, `READY`, `ERROR`, `DELETING`).

### Definition

- `EnvironmentService` - this is a container thats managed by a service in this application. The service managed the configuration and lifecycle of the container.

### New models
- `Environment` model storing id, name, slug, type, status, dockerProjectName, optional description, createdBy/updatedBy relations to `User`, and timestamps. Enforce unique `slug` and unique `(dockerProjectName)`.
- `EnvironmentNetwork` referencing `Environment` with fields for name, dockerNetworkName, driver, options JSON, status enum, dockerId, createdAt/updatedAt, and `lastSyncedAt`. Unique `(environmentId, name)`.
- `EnvironmentVolume` referencing `Environment` with name, dockerVolumeName, driver, mountpoint, labels JSON, status, dockerId, createdAt/updatedAt. Unique `(environmentId, name)`.
- `EnvironmentService` capturing desired service and container definitions: name, image, tag, ports JSON, lastDeployedAt, dockerContainerId, createdAt/updatedAt. Unique `(environmentId, name)`.
- `EnvironmentActivity` (optional but recommended) for audit trail: environmentId, resourceType, resourceId, action, status, message, metadata JSON, createdBy, createdAt.

### Migrations and seed data
- Generate Prisma migration after schema changes; ensure existing SQLite data is migrated (consider writing a data backfill script to populate `dockerProjectName` using slugified name).
- Extend Prisma client generation and update any TypeScript types impacted by new enums/models.
- Optionally seed one sample environment in development fixtures to validate UI.

## Backend Changes
### Routing
- Register a new Express router at `/api/environments` in `server/src/app.ts` alongside existing module routers.
- Implement REST endpoints in `server/src/routes/environments.ts` with Zod validation:
  - `GET /api/environments` — list environments with filters (type, status, search by name) and pagination metadata.
  - `POST /api/environments` — create environment (name, type, description). Respond immediately with `PROVISIONING` status while async work runs.
  - `GET /api/environments/:environmentId` — return environment details plus aggregated resource counts and latest activities.
  - `PATCH /api/environments/:environmentId` — update name/type/description; prevent type change to `PROD` unless validations pass.
  - `DELETE /api/environments/:environmentId` — trigger teardown workflow, mark status `DELETING` and return accepted response.
  - Nested resource endpoints: `/networks`, `/volumes`, `/containers` (create/list/update/delete) under each environment. Include actions such as `/containers/:id/start`, `/containers/:id/stop`, `/containers/:id/redeploy`.

### Services & orchestration
- Introduce `EnvironmentService` (`server/src/services/environment-service.ts`) encapsulating Prisma reads/writes and Docker orchestration. Provide methods for `createEnvironment`, `deleteEnvironment`, `createNetwork`, `createVolume` etc.
- The `EnvironmentService` will use other services like `haproxy-service` to implement them.
- There should be a single list of services and the classes that implemenat that service.
- Leverage existing `ContainerLifecycleManager` to start/stop environment containers; add ability to scope operations by environmentId.
- Add background job or queue integration using existing in-memory queue to perform long-running Docker tasks (create network/volumes/containers) so HTTP requests can respond quickly while tracking progress.
- Persist environment activities upon each lifecycle event (creation start/success/failure, container start/stop).

### Validation, security, and error handling
- Reuse `requireSessionOrApiKey` middleware and `getAuthenticatedUser` for audit metadata.
- Validate Docker resource names to avoid collisions (prefix with sanitized slug) before creation.
- Guard destructive actions (deleting `PROD` environments or resources) with confirmation flags and double-check dependencies (e.g., prevent deleting a network while containers still attached).
- Implement consistent error responses via existing `error-handler` utilities; map Docker errors to user-friendly messages.

### Observability
- Update logging (using `servicesLogger`) to include `environmentId`, resource type, and action fields.
- Consider metrics/tracing hooks for environment operations if Prometheus/ELK integration exists later.

### Testing
- Add unit tests for `EnvironmentService` covering success and failure paths (network collision, Docker error propagation) using dockerode mocks.
- Add route integration tests in `server/src/routes/__tests__/environments.test.ts` verifying validation, auth, and state transitions.
- Update any affected snapshot tests and ensure Prisma schema passes `prisma validate` in CI.

## Client Changes
### Navigation & routing
- Add an "Environments" entry to the sidebar (`client/src/components/app-sidebar.tsx`) with icon + route.
- Extend `client/src/lib/routes.tsx` to include `environments` index and nested detail routes under the protected layout (e.g., `/environments` and `/environments/:environmentId`).

### Data layer
- Create hooks in `client/src/hooks`:
  - `use-environments.ts` for list fetching, filters, and creation mutation.
  - `use-environment.ts` for detail queries, resource CRUD mutations, and optimistic updates.
  - `use-environment-activities.ts` if activity timeline is exposed.
- Centralize API client methods (e.g., in `lib/utils.ts` or a new `lib/api/environments.ts`) to call new REST endpoints and normalize responses.

### Pages & components
- Create `client/src/app/environments/page.tsx` for listing environments with table/cards: show name, type badge, status pill, resource counts, last updated, and quick actions (view, delete, create).
- Create `client/src/app/environments/[environmentId]/page.tsx` (or folder with `layout.tsx`) for detail view featuring:
  - Header with environment metadata editing (rename, type toggle) and status indicator.
  - Tabs or sections for Networks, Volumes, Containers, and Activity.
  - Forms/dialogs to add network/volume/container using validated inputs and referencing existing component primitives (modals, forms, data tables).
- Reuse existing generic components (data-table, section cards) where possible; create new small components for environment badges, status chips, and confirm dialogs.

### UX considerations
- Provide clear warnings when performing destructive actions, especially in `PROD` environments (e.g., require typing the environment name).
- Surface async progress via toasts and inline status updates (leveraging existing `toast-utils`).
- Ensure forms have sensible defaults (e.g., auto-generated Docker resource names based on environment slug) but allow overrides.
- Add empty states for each tab and include quick links to documentation/help.

### Frontend testing
- Add component/unit tests with React Testing Library for list and detail pages focusing on rendering states and mutation handlers.
- If using MSW or similar, extend API mocks to cover new endpoints for storybook/dev preview.
- Update end-to-end testing (if applicable) to cover environment creation flow.

## Delivery Phasing
1. **Phase 1 – Schema & API foundations**: implement Prisma changes, run migrations, build backend list/create/delete endpoints, and supply unit tests.
2. **Phase 2 – Resource orchestration**: finish Docker integration, nested resource endpoints, and background job handling; ensure activities logging works.
3. **Phase 3 – UI list & detail**: ship environment listing page with create/delete flows; include feature-flag guard if necessary.
4. **Phase 4 – Resource management UI**: add networks/volumes/containers management UI, deep-linking, and polished UX states.
5. **Phase 5 – Hardening**: write regression tests, add telemetry/alerts, docs updates, and finalize access policies before GA.
