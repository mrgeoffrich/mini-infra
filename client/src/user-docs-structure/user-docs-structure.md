# User Docs Structure

Generated: 2026-03-08

## Coverage Summary

- Total user-visible routes: 46
- Routes fully covered: 41 ✅
- Routes partially covered / inferred: 5 ⚠️
- Routes missing coverage: 0 ❌
- Extra defined articles (from extra-docs-defined.md): 15 total, 15 ✅ exist, 0 ❌ not yet created

---

## Route Coverage by Section

### Dashboard

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/dashboard` | Dashboard | ✅ | `getting-started/overview.md` |

### Applications

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/containers` | Containers | ✅ | `containers/viewing-containers.md` |
| `/containers/:id` | Container Details | ✅ | `containers/managing-containers.md` |
| `/containers/volumes/:name/inspect` | Volume Inspect | ✅ | `containers/volume-management.md` |
| `/containers/volumes/:name/files/*` | Volume File Content | ✅ | `containers/volume-management.md` |
| `/deployments` | Deployments | ✅ | `deployments/deployment-overview.md` |
| `/deployments/new` | New Deployment Configuration | ✅ | `deployments/creating-deployments.md` |
| `/deployments/:id` | Deployment Details | ✅ | `deployments/deployment-lifecycle.md` |
| `/environments` | Environments | ✅ | `deployments/environments.md` |
| `/environments/:id` | Environment Details | ⚠️ | Parent covered by `deployments/environments.md` |
| `/host` | Host | ✅ | `applications/host-stacks.md` |

### Databases

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/postgres-server` | Postgres Servers | ✅ | `postgres-backups/backup-overview.md` |
| `/postgres-server/:serverId` | Server Details | ⚠️ | Parent covered by `postgres-backups/backup-overview.md` |
| `/postgres-server/:serverId/databases/:dbId` | Database Details | ✅ | `postgres-backups/database-management.md` |
| `/postgres-backup` | Postgres Backups | ✅ | `postgres-backups/backup-overview.md` |
| `/postgres-backup/:databaseId/restore` | Restore Database | ✅ | `postgres-backups/restoring-backups.md` |

### Networking

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/tunnels` | Cloudflare Tunnels | ✅ | `tunnels/tunnel-monitoring.md` |
| `/haproxy/frontends` | Frontends | ✅ | `deployments/haproxy-frontends.md` |
| `/haproxy/frontends/new/manual` | Connect Container | ✅ | `deployments/haproxy-frontends.md` |
| `/haproxy/frontends/:frontendName` | Frontend Details | ✅ | `deployments/haproxy-frontends.md` |
| `/haproxy/frontends/:frontendName/edit` | Edit Frontend | ✅ | `deployments/haproxy-frontends.md` |
| `/haproxy/backends` | Backends | ✅ | `deployments/haproxy-backends.md` |
| `/haproxy/backends/:backendName` | Backend Details | ✅ | `deployments/haproxy-backends.md` |
| `/haproxy/instances` | Instances | ✅ | `deployments/haproxy-instances.md` |
| `/certificates` | TLS Certificates | ✅ | `networking/tls-certificates.md` |
| `/certificates/:id` | Certificate Details | ⚠️ | Parent covered by `networking/tls-certificates.md` |

### Monitoring

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/logs` | Container Logs | ✅ | `monitoring/container-logs.md` |
| `/logs/fullscreen` | Container Logs (Fullscreen) | ✅ | `monitoring/container-logs.md` (variant of `/logs`) |
| `/monitoring` | Container Metrics | ✅ | `monitoring/container-metrics.md` |
| `/events` | Events | ✅ | `monitoring/events.md` |
| `/events/:id` | Event Details | ⚠️ | Parent covered by `monitoring/events.md` |

### Connected Services

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/connectivity-docker` | Docker | ✅ | `connectivity/health-monitoring.md` |
| `/connectivity-cloudflare` | Cloudflare | ✅ | `connectivity/health-monitoring.md` |
| `/connectivity-azure` | Azure Storage | ✅ | `connectivity/health-monitoring.md` |
| `/connectivity-github` | GitHub | ✅ | `connectivity/health-monitoring.md` |

### Administration

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/api-keys` | API Keys | ✅ | `settings/api-keys.md` |
| `/api-keys/new` | Create API Key | ⚠️ | Parent covered by `settings/api-keys.md` |
| `/api-keys/presets` | Permission Presets | ✅ | `settings/permission-presets.md` |
| `/settings-system` | System Settings | ✅ | `settings/system-settings.md` |
| `/settings-security` | Security Settings | ✅ | `settings/security-settings.md` |
| `/settings-registry-credentials` | Registry Credentials | ✅ | `settings/system-settings.md` |
| `/settings-self-backup` | Self-Backup Settings | ✅ | `postgres-backups/configuring-backups.md` |
| `/settings-tls` | TLS Settings | ✅ | `settings/tls-settings.md` |
| `/settings-ai-assistant` | AI Assistant | ✅ | `settings/ai-assistant.md` |

### Other (not in sidebar navigation)

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/bug-report-settings` | Bug Report Settings | ✅ | `github/github-app-setup.md` |
| `/user/settings` | User Settings | ✅ | `settings/user-preferences.md` |

---

## Extra Docs Coverage

These articles are defined in `extra-docs-defined.md` and supplement the route-driven docs. They are not directly linked from a route `helpDoc` field (though some may also serve as a route helpDoc).

| File | Title | Category | Status |
|------|-------|----------|--------|
| `getting-started/navigating-the-dashboard.md` | Navigating the Dashboard | getting-started | ✅ |
| `getting-started/running-with-docker.md` | Running Mini Infra with Docker | getting-started | ✅ |
| `containers/container-logs.md` | Viewing Container Logs | containers | ✅ |
| `containers/container-actions.md` | Container Actions Reference | containers | ✅ |
| `containers/troubleshooting.md` | Container Troubleshooting | containers | ✅ |
| `deployments/deployment-lifecycle.md` | Deployment Lifecycle | deployments | ✅ |
| `deployments/troubleshooting.md` | Deployment Troubleshooting | deployments | ✅ |
| `postgres-backups/database-management.md` | Managing PostgreSQL Databases | postgres-backups | ✅ |
| `postgres-backups/troubleshooting.md` | PostgreSQL Backup Troubleshooting | postgres-backups | ✅ |
| `tunnels/troubleshooting.md` | Cloudflare Tunnel Troubleshooting | tunnels | ✅ |
| `connectivity/troubleshooting.md` | Connected Services Troubleshooting | connectivity | ✅ |
| `github/packages-and-registries.md` | GitHub Packages and Container Registries | github | ✅ |
| `github/repository-integration.md` | GitHub Repository Integration | github | ✅ |
| `github/troubleshooting.md` | GitHub Integration Troubleshooting | github | ✅ |
| `api/api-overview.md` | API Overview | api | ✅ |

---

## Existing Docs Inventory

### applications

| File | Title | Description |
|------|-------|-------------|
| `host-stacks.md` | Host Infrastructure Stacks | How to manage host-level infrastructure stacks with plan and apply semantics in Mini Infra. |

### api

| File | Title | Description |
|------|-------|-------------|
| `api-overview.md` | API Overview | An overview of how to use the Mini Infra REST API with API keys. |

### connectivity

| File | Title | Description |
|------|-------|-------------|
| `health-monitoring.md` | Connected Services Health Monitoring | How to configure and monitor external service connections in Mini Infra. |
| `troubleshooting.md` | Connected Services Troubleshooting | Common issues with external service connections and how to resolve them. |

### containers

| File | Title | Description |
|------|-------|-------------|
| `viewing-containers.md` | Viewing and Filtering Containers | How to view, search, and filter Docker containers in Mini Infra. |
| `managing-containers.md` | Managing a Container | How to view details, run actions, and inspect a specific container. |
| `volume-management.md` | Volume Management | How to inspect, browse, and manage Docker volumes in Mini Infra. |
| `container-logs.md` | Viewing Container Logs | How to view and use the container log viewer in Mini Infra. |
| `container-actions.md` | Container Actions Reference | Reference for all actions you can perform on Docker containers in Mini Infra. |
| `troubleshooting.md` | Container Troubleshooting | Common container issues and how to resolve them in Mini Infra. |

### deployments

| File | Title | Description |
|------|-------|-------------|
| `deployment-overview.md` | Deployments Overview | An overview of how zero-downtime deployments work in Mini Infra. |
| `creating-deployments.md` | Creating a Deployment Configuration | How to create and configure a new zero-downtime deployment in Mini Infra. |
| `deployment-lifecycle.md` | Deployment Lifecycle | A step-by-step guide to what happens during a deployment in Mini Infra. |
| `environments.md` | Managing Environments | How to create and manage environments that group services and infrastructure in Mini Infra. |
| `haproxy-frontends.md` | Managing HAProxy Frontends | How to view, create, and configure HAProxy frontends in Mini Infra. |
| `haproxy-backends.md` | Managing HAProxy Backends | How to view and configure HAProxy backends in Mini Infra. |
| `haproxy-instances.md` | HAProxy Instances | How to monitor HAProxy health across environments and remediate or migrate instances in Mini Infra. |
| `troubleshooting.md` | Deployment Troubleshooting | Common deployment issues and how to resolve them in Mini Infra. |

### getting-started

| File | Title | Description |
|------|-------|-------------|
| `overview.md` | Getting Started with Mini Infra | An introduction to Mini Infra and what you can do with it. |
| `navigating-the-dashboard.md` | Navigating the Dashboard | A guide to finding your way around the Mini Infra interface. |
| `running-with-docker.md` | Running Mini Infra with Docker | How to run Mini Infra using Docker or Docker Compose. |

### github

| File | Title | Description |
|------|-------|-------------|
| `github-app-setup.md` | Setting Up the GitHub App | How to connect Mini Infra to GitHub using the GitHub App integration. |
| `packages-and-registries.md` | GitHub Packages and Container Registries | How to browse GitHub Container Registry packages connected through the GitHub App. |
| `repository-integration.md` | GitHub Repository Integration | How to view repositories, monitor GitHub Actions, and configure bug reporting with GitHub. |
| `troubleshooting.md` | GitHub Integration Troubleshooting | Common GitHub integration issues and how to resolve them. |

### monitoring

| File | Title | Description |
|------|-------|-------------|
| `events.md` | Event Log | How to view and manage the system event log in Mini Infra. |
| `container-logs.md` | Searching Container Logs | How to search, filter, and stream centralized container logs in Mini Infra. |
| `container-metrics.md` | Container Metrics | How to monitor CPU, memory, and network usage across Docker containers in Mini Infra. |

### networking

| File | Title | Description |
|------|-------|-------------|
| `tls-certificates.md` | TLS Certificate Management | How to issue, renew, and manage SSL/TLS certificates in Mini Infra. |

### postgres-backups

| File | Title | Description |
|------|-------|-------------|
| `backup-overview.md` | PostgreSQL Backup Overview | An overview of how PostgreSQL backup management works in Mini Infra. |
| `configuring-backups.md` | Configuring Backup Schedules | How to configure automated PostgreSQL backup schedules in Mini Infra. |
| `restoring-backups.md` | Restoring a PostgreSQL Backup | How to browse backups and restore a PostgreSQL database in Mini Infra. |
| `database-management.md` | Managing PostgreSQL Databases | How to add, edit, and manage PostgreSQL database connections in Mini Infra. |
| `troubleshooting.md` | PostgreSQL Backup Troubleshooting | Common PostgreSQL backup and restore issues and how to resolve them. |

### settings

| File | Title | Description |
|------|-------|-------------|
| `api-keys.md` | Managing API Keys | How to create, manage, and revoke API keys for programmatic access to Mini Infra. |
| `permission-presets.md` | API Key Permission Presets | How to create and manage reusable permission templates for API keys. |
| `system-settings.md` | System Settings | How to configure system-wide settings including Docker images, HAProxy ports, and event retention. |
| `security-settings.md` | Security Settings | How to manage and regenerate security secrets in Mini Infra. |
| `tls-settings.md` | TLS Settings | How to configure certificate storage, ACME provider, and renewal scheduling for TLS certificates. |
| `user-preferences.md` | User Preferences | How to configure personal settings like timezone in Mini Infra. |
| `ai-assistant.md` | AI Assistant Settings | How to configure the AI assistant's API key, model, and view its capabilities in Mini Infra. |

### tunnels

| File | Title | Description |
|------|-------|-------------|
| `tunnel-monitoring.md` | Monitoring Cloudflare Tunnels | How to monitor Cloudflare tunnel health and manage hostnames in Mini Infra. |
| `troubleshooting.md` | Cloudflare Tunnel Troubleshooting | Common issues with Cloudflare tunnel monitoring and how to resolve them. |

---

## Proposed New Articles

No missing route coverage — all routes have a helpDoc pointing to an existing article.

---

## Extra Docs Still To Create

All 15 articles defined in `extra-docs-defined.md` have been created. Nothing remaining.

---

## Orphaned Docs

No orphaned docs found. Every article in `user-docs/` is either referenced by a route `helpDoc` or listed in `extra-docs-defined.md`.
