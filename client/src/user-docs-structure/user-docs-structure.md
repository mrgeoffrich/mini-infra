# User Docs Structure

Generated: 2026-03-01

## Coverage Summary

- Total user-visible routes: 41
- Routes fully covered: 0 ✅
- Routes partially covered / inferred: 0 ⚠️
- Routes missing coverage: 41 ❌ (19 have a `helpDoc` set but the file is missing; 22 have no `helpDoc`)
- Extra defined articles (from extra-docs-defined.md): 15 total, 0 ✅ exist, 15 ❌ not yet created

> **Note:** `client/src/user-docs/` does not currently exist — all articles were deleted in preparation for a fresh generation. Every status below is ❌.

---

## Route Coverage by Section

### Dashboard

| Route | Page Title | Detail page? | helpDoc | Status |
|-------|-----------|:---:|---------|--------|
| `/dashboard` | Dashboard | | `getting-started/overview` | ❌ broken helpDoc link |

---

### Applications

| Route | Page Title | Detail page? | helpDoc | Status |
|-------|-----------|:---:|---------|--------|
| `/containers` | Containers | | `containers/viewing-containers` | ❌ broken helpDoc link |
| `/containers/:id` | Container Detail | ✓ | — | ❌ no coverage |
| `/containers/volumes/:name/inspect` | Volume Inspect | ✓ | — | ❌ no coverage |
| `/containers/volumes/:name/files/*` | Volume File Content | ✓ | — | ❌ no coverage |
| `/deployments` | Deployments | | `deployments/deployment-overview` | ❌ broken helpDoc link |
| `/deployments/new` | New Deployment Configuration | | `deployments/creating-deployments` | ❌ broken helpDoc link |
| `/deployments/:id` | Deployment Details | ✓ | — | ❌ no coverage |
| `/environments` | Environments | | — | ❌ no coverage |
| `/environments/:id` | Environment Details | ✓ | — | ❌ no coverage |

---

### Databases

| Route | Page Title | Detail page? | helpDoc | Status |
|-------|-----------|:---:|---------|--------|
| `/postgres-server` | Postgres Servers | | `postgres-backups/backup-overview` | ❌ broken helpDoc link |
| `/postgres-server/:serverId` | Server Details | ✓ | — | ❌ no coverage |
| `/postgres-server/:serverId/databases/:dbId` | Database Detail | ✓ | — | ❌ no coverage |
| `/postgres-backup` | Postgres Backups | | `postgres-backups/backup-overview` | ❌ broken helpDoc link |
| `/postgres-backup/:databaseId/restore` | Restore Database | ✓ | `postgres-backups/restoring-backups` | ❌ broken helpDoc link |

---

### Networking

| Route | Page Title | Detail page? | helpDoc | Status |
|-------|-----------|:---:|---------|--------|
| `/tunnels` | Cloudflare Tunnels | | `tunnels/tunnel-monitoring` | ❌ broken helpDoc link |
| `/haproxy` | Load Balancer (→ redirects to /haproxy/frontends) | | `deployments/deployment-overview` | ❌ broken helpDoc link |
| `/haproxy/frontends` | Frontends | | — | ❌ no coverage |
| `/haproxy/frontends/new/manual` | Connect Container | | — | ❌ no coverage |
| `/haproxy/frontends/:frontendName` | Frontend Details | ✓ | — | ❌ no coverage |
| `/haproxy/frontends/:frontendName/edit` | Edit Frontend | ✓ | — | ❌ no coverage |
| `/haproxy/backends` | Backends | | — | ❌ no coverage |
| `/haproxy/backends/:backendName` | Backend Details | ✓ | — | ❌ no coverage |
| `/certificates` | TLS Certificates | | — | ❌ no coverage |
| `/certificates/:id` | Certificate Details | ✓ | — | ❌ no coverage |

---

### Monitoring

| Route | Page Title | Detail page? | helpDoc | Status |
|-------|-----------|:---:|---------|--------|
| `/events` | Events | | — | ❌ no coverage |
| `/events/:id` | Event Details | ✓ | — | ❌ no coverage |

---

### Connected Services

| Route | Page Title | Detail page? | helpDoc | Status |
|-------|-----------|:---:|---------|--------|
| `/connectivity-docker` | Docker | | `connectivity/health-monitoring` | ❌ broken helpDoc link |
| `/connectivity-cloudflare` | Cloudflare | | `connectivity/health-monitoring` | ❌ broken helpDoc link |
| `/connectivity-azure` | Azure Storage | | `connectivity/health-monitoring` | ❌ broken helpDoc link |
| `/connectivity-github` | GitHub | | `connectivity/health-monitoring` | ❌ broken helpDoc link |

---

### Administration

| Route | Page Title | Detail page? | helpDoc | Status |
|-------|-----------|:---:|---------|--------|
| `/api-keys` | API Keys | | `settings/api-keys` | ❌ broken helpDoc link |
| `/api-keys/new` | Create API Key | | — | ❌ no coverage |
| `/api-keys/presets` | Permission Presets | | — | ❌ no coverage |
| `/settings-system` | System Settings | | `settings/system-settings` | ❌ broken helpDoc link |
| `/settings-security` | Security Settings | | — | ❌ no coverage |
| `/settings-registry-credentials` | Registry Credentials | | `settings/system-settings` | ❌ broken helpDoc link |
| `/settings-self-backup` | Self-Backup Settings | | `postgres-backups/configuring-backups` | ❌ broken helpDoc link |
| `/settings-tls` | TLS Settings | | — | ❌ no coverage |
| `/bug-report-settings` | Bug Report Settings | | `github/github-app-setup` | ❌ broken helpDoc link |

---

### User

| Route | Page Title | Detail page? | helpDoc | Status |
|-------|-----------|:---:|---------|--------|
| `/user/settings` | User Settings | | `settings/user-preferences` | ❌ broken helpDoc link |

---

## Extra Docs Coverage

These articles are defined in `extra-docs-defined.md` and supplement the route-driven docs. None currently exist in `client/src/user-docs/`.

| File | Title | Category | Status |
|------|-------|----------|--------|
| `getting-started/navigating-the-dashboard.md` | Navigating the Dashboard | getting-started | ❌ not yet created |
| `getting-started/running-with-docker.md` | Running Mini Infra with Docker | getting-started | ❌ not yet created |
| `containers/container-logs.md` | Viewing Container Logs | containers | ❌ not yet created |
| `containers/container-actions.md` | Container Actions Reference | containers | ❌ not yet created |
| `containers/troubleshooting.md` | Container Troubleshooting | containers | ❌ not yet created |
| `deployments/deployment-lifecycle.md` | Deployment Lifecycle | deployments | ❌ not yet created |
| `deployments/troubleshooting.md` | Deployment Troubleshooting | deployments | ❌ not yet created |
| `postgres-backups/database-management.md` | Managing PostgreSQL Databases | postgres-backups | ❌ not yet created |
| `postgres-backups/troubleshooting.md` | PostgreSQL Backup Troubleshooting | postgres-backups | ❌ not yet created |
| `tunnels/troubleshooting.md` | Cloudflare Tunnel Troubleshooting | tunnels | ❌ not yet created |
| `connectivity/troubleshooting.md` | Connected Services Troubleshooting | connectivity | ❌ not yet created |
| `github/packages-and-registries.md` | GitHub Packages and Container Registries | github | ❌ not yet created |
| `github/repository-integration.md` | GitHub Repository Integration | github | ❌ not yet created |
| `github/troubleshooting.md` | GitHub Integration Troubleshooting | github | ❌ not yet created |
| `api/api-overview.md` | API Overview | api | ❌ not yet created |

---

## Existing Docs Inventory

`client/src/user-docs/` does not exist. No articles are currently present.

---

## Proposed New Articles

### Route-linked articles (required by `helpDoc` references)

These files are referenced by route `helpDoc` fields and must be created to restore contextual help links.

| Route(s) using it | Suggested File | Suggested Title | Suggested Category |
|-------------------|---------------|-----------------|-------------------|
| `/dashboard` | `getting-started/overview.md` | Getting Started with Mini Infra | getting-started |
| `/containers` | `containers/viewing-containers.md` | Viewing and Filtering Containers | containers |
| `/deployments`, `/haproxy` | `deployments/deployment-overview.md` | Deployments Overview | deployments |
| `/deployments/new` | `deployments/creating-deployments.md` | Creating a Deployment Configuration | deployments |
| `/postgres-server`, `/postgres-backup` | `postgres-backups/backup-overview.md` | PostgreSQL Backup Overview | postgres-backups |
| `/postgres-backup/:databaseId/restore` | `postgres-backups/restoring-backups.md` | Restoring a PostgreSQL Backup | postgres-backups |
| `/settings-self-backup` | `postgres-backups/configuring-backups.md` | Configuring Backup Schedules | postgres-backups |
| `/tunnels` | `tunnels/tunnel-monitoring.md` | Monitoring Cloudflare Tunnels | tunnels |
| `/connectivity-docker`, `/connectivity-cloudflare`, `/connectivity-azure`, `/connectivity-github` | `connectivity/health-monitoring.md` | Connected Services Health Monitoring | connectivity |
| `/api-keys` | `settings/api-keys.md` | Managing API Keys | settings |
| `/settings-system`, `/settings-registry-credentials` | `settings/system-settings.md` | System Settings | settings |
| `/user/settings` | `settings/user-preferences.md` | User Preferences | settings |
| `/bug-report-settings` | `github/github-app-setup.md` | Setting Up the GitHub App | github |

### Articles for uncovered routes (no `helpDoc` set)

For detail pages that share the same feature as the parent page, the suggested article is the same as the parent's; no separate file is needed. New standalone articles are marked **NEW**.

| Route | Suggested File | Suggested Title | Suggested Category | New? |
|-------|---------------|-----------------|-------------------|------|
| `/containers/:id` | `containers/managing-containers.md` | Managing a Container | containers | **NEW** |
| `/containers/volumes/:name/inspect` | `containers/volume-management.md` | Volume Management | containers | **NEW** |
| `/containers/volumes/:name/files/*` | `containers/volume-management.md` | *(shares volume-management.md)* | containers | — |
| `/deployments/:id` | `deployments/deployment-lifecycle.md` | *(covered by extra-defined lifecycle doc)* | deployments | — |
| `/environments` | `deployments/environments.md` | Managing Environments | deployments | **NEW** |
| `/environments/:id` | `deployments/environments.md` | *(shares environments.md)* | deployments | — |
| `/postgres-server/:serverId` | `postgres-backups/backup-overview.md` | *(shares backup-overview.md)* | postgres-backups | — |
| `/postgres-server/:serverId/databases/:dbId` | `postgres-backups/database-management.md` | *(covered by extra-defined database-management doc)* | postgres-backups | — |
| `/haproxy/frontends` | `deployments/haproxy-frontends.md` | Managing HAProxy Frontends | deployments | **NEW** |
| `/haproxy/frontends/new/manual` | `deployments/haproxy-frontends.md` | *(shares haproxy-frontends.md)* | deployments | — |
| `/haproxy/frontends/:frontendName` | `deployments/haproxy-frontends.md` | *(shares haproxy-frontends.md)* | deployments | — |
| `/haproxy/frontends/:frontendName/edit` | `deployments/haproxy-frontends.md` | *(shares haproxy-frontends.md)* | deployments | — |
| `/haproxy/backends` | `deployments/haproxy-backends.md` | Managing HAProxy Backends | deployments | **NEW** |
| `/haproxy/backends/:backendName` | `deployments/haproxy-backends.md` | *(shares haproxy-backends.md)* | deployments | — |
| `/certificates` | `networking/tls-certificates.md` | TLS Certificate Management | networking | **NEW** |
| `/certificates/:id` | `networking/tls-certificates.md` | *(shares tls-certificates.md)* | networking | — |
| `/events` | `monitoring/events.md` | Event Log | monitoring | **NEW** |
| `/events/:id` | `monitoring/events.md` | *(shares events.md)* | monitoring | — |
| `/api-keys/new` | `settings/api-keys.md` | *(shares api-keys.md)* | settings | — |
| `/api-keys/presets` | `settings/permission-presets.md` | API Key Permission Presets | settings | **NEW** |
| `/settings-security` | `settings/security-settings.md` | Security Settings | settings | **NEW** |
| `/settings-tls` | `settings/tls-settings.md` | TLS Settings | settings | **NEW** |

---

## Extra Docs Still To Create

All 15 extra articles defined in `extra-docs-defined.md` need to be written:

| File | Title | Category |
|------|-------|----------|
| `getting-started/navigating-the-dashboard.md` | Navigating the Dashboard | getting-started |
| `getting-started/running-with-docker.md` | Running Mini Infra with Docker | getting-started |
| `containers/container-logs.md` | Viewing Container Logs | containers |
| `containers/container-actions.md` | Container Actions Reference | containers |
| `containers/troubleshooting.md` | Container Troubleshooting | containers |
| `deployments/deployment-lifecycle.md` | Deployment Lifecycle | deployments |
| `deployments/troubleshooting.md` | Deployment Troubleshooting | deployments |
| `postgres-backups/database-management.md` | Managing PostgreSQL Databases | postgres-backups |
| `postgres-backups/troubleshooting.md` | PostgreSQL Backup Troubleshooting | postgres-backups |
| `tunnels/troubleshooting.md` | Cloudflare Tunnel Troubleshooting | tunnels |
| `connectivity/troubleshooting.md` | Connected Services Troubleshooting | connectivity |
| `github/packages-and-registries.md` | GitHub Packages and Container Registries | github |
| `github/repository-integration.md` | GitHub Repository Integration | github |
| `github/troubleshooting.md` | GitHub Integration Troubleshooting | github |
| `api/api-overview.md` | API Overview | api |

---

## Orphaned Docs

No docs exist in `user-docs/` at all — there are no orphans to report.

---

## Full Article Target List

For reference, the complete set of articles to create (route-linked + extra-defined + new proposals):

### getting-started/
- `overview.md` — Getting Started with Mini Infra *(helpDoc for /dashboard)*
- `navigating-the-dashboard.md` — Navigating the Dashboard *(extra-defined)*
- `running-with-docker.md` — Running Mini Infra with Docker *(extra-defined)*

### containers/
- `viewing-containers.md` — Viewing and Filtering Containers *(helpDoc for /containers)*
- `managing-containers.md` — Managing a Container *(new, for /containers/:id)*
- `volume-management.md` — Volume Management *(new, for /containers/volumes/*)*
- `container-logs.md` — Viewing Container Logs *(extra-defined)*
- `container-actions.md` — Container Actions Reference *(extra-defined)*
- `troubleshooting.md` — Container Troubleshooting *(extra-defined)*

### deployments/
- `deployment-overview.md` — Deployments Overview *(helpDoc for /deployments, /haproxy)*
- `creating-deployments.md` — Creating a Deployment Configuration *(helpDoc for /deployments/new)*
- `deployment-lifecycle.md` — Deployment Lifecycle *(extra-defined; also for /deployments/:id detail)*
- `environments.md` — Managing Environments *(new, for /environments)*
- `haproxy-frontends.md` — Managing HAProxy Frontends *(new, for /haproxy/frontends)*
- `haproxy-backends.md` — Managing HAProxy Backends *(new, for /haproxy/backends)*
- `troubleshooting.md` — Deployment Troubleshooting *(extra-defined)*

### postgres-backups/
- `backup-overview.md` — PostgreSQL Backup Overview *(helpDoc for /postgres-server, /postgres-backup)*
- `configuring-backups.md` — Configuring Backup Schedules *(helpDoc for /settings-self-backup)*
- `restoring-backups.md` — Restoring a PostgreSQL Backup *(helpDoc for /postgres-backup/:databaseId/restore)*
- `database-management.md` — Managing PostgreSQL Databases *(extra-defined; also for /postgres-server/:serverId/databases/:dbId)*
- `troubleshooting.md` — PostgreSQL Backup Troubleshooting *(extra-defined)*

### tunnels/
- `tunnel-monitoring.md` — Monitoring Cloudflare Tunnels *(helpDoc for /tunnels)*
- `troubleshooting.md` — Cloudflare Tunnel Troubleshooting *(extra-defined)*

### connectivity/
- `health-monitoring.md` — Connected Services Health Monitoring *(helpDoc for all /connectivity-* pages)*
- `troubleshooting.md` — Connected Services Troubleshooting *(extra-defined)*

### networking/
- `tls-certificates.md` — TLS Certificate Management *(new, for /certificates)*

### monitoring/
- `events.md` — Event Log *(new, for /events)*

### settings/
- `api-keys.md` — Managing API Keys *(helpDoc for /api-keys)*
- `permission-presets.md` — API Key Permission Presets *(new, for /api-keys/presets)*
- `system-settings.md` — System Settings *(helpDoc for /settings-system, /settings-registry-credentials)*
- `security-settings.md` — Security Settings *(new, for /settings-security)*
- `tls-settings.md` — TLS Settings *(new, for /settings-tls)*
- `user-preferences.md` — User Preferences *(helpDoc for /user/settings)*

### github/
- `github-app-setup.md` — Setting Up the GitHub App *(helpDoc for /bug-report-settings)*
- `packages-and-registries.md` — GitHub Packages and Container Registries *(extra-defined)*
- `repository-integration.md` — GitHub Repository Integration *(extra-defined)*
- `troubleshooting.md` — GitHub Integration Troubleshooting *(extra-defined)*

### api/
- `api-overview.md` — API Overview *(extra-defined)*
