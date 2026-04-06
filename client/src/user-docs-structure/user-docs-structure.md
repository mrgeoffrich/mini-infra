# User Docs Structure

Generated: 2026-04-06

## Coverage Summary

- Total user-visible routes: 48
- Routes fully covered: 43 ✅
- Routes partially covered (parent has doc): 5 ⚠️
- Routes with broken helpDoc (article missing): 0 ❌
- Routes with no helpDoc: 0 🔲
- Extra defined articles (from extra-docs-defined.md): 13 total, 13 ✅ exist, 0 ❌ not yet created

---

## Route Coverage by Section

### Dashboard

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/dashboard` | Dashboard | ✅ | `getting-started/overview` | ✅ |

### Applications

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/applications` | Applications | ✅ | `applications/application-management` | ✅ |
| `/applications/new` | New Application | ✅ | `applications/application-management` | ✅ |
| `/applications/:id` | Application Details | ✅ | `applications/application-management` | ✅ |
| `/environments` | Environments | ✅ | `environments/environments` | ✅ |
| `/environments/:id` | Environment Details | ⚠️ | (none, parent has doc) | — |
| `/host` | Host | ✅ | `applications/host-stacks` | ✅ |
| `/stack-templates` | Stack Templates | ✅ | `applications/stack-templates` | ✅ |
| `/stack-templates/:templateId` | Stack Template | ✅ | `applications/stack-templates` | ✅ |

### Containers

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/containers` | Containers | ✅ | `containers/viewing-containers` | ✅ |
| `/containers/:id` | Container Details | ✅ | `containers/managing-containers` | ✅ |
| `/containers/volumes/:name/inspect` | Volume Inspect | ✅ | `containers/volume-management` | ✅ |
| `/containers/volumes/:name/files/*` | Volume File Content | ✅ | `containers/volume-management` | ✅ |

### Databases

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/postgres-server` | Postgres Servers | ✅ | `postgres-backups/backup-overview` | ✅ |
| `/postgres-server/:serverId` | Server Details | ⚠️ | (none, parent has doc) | — |
| `/postgres-server/:serverId/databases/:dbId` | Database Details | ✅ | `postgres-backups/database-management` | ✅ |
| `/postgres-backup` | Postgres Backups | ✅ | `postgres-backups/backup-overview` | ✅ |
| `/postgres-backup/:databaseId/restore` | Restore Database | ✅ | `postgres-backups/restoring-backups` | ✅ |

### Networking

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/tunnels` | Cloudflare Tunnels | ✅ | `tunnels/tunnel-monitoring` | ✅ |
| `/haproxy` | Load Balancer | ✅ | `haproxy/haproxy-overview` | ✅ |
| `/haproxy/frontends` | Frontends | ✅ | `haproxy/haproxy-frontends` | ✅ |
| `/haproxy/frontends/new/manual` | Connect Container | ✅ | `haproxy/haproxy-frontends` | ✅ |
| `/haproxy/frontends/:frontendName` | Frontend Details | ✅ | `haproxy/haproxy-frontends` | ✅ |
| `/haproxy/frontends/:frontendName/edit` | Edit Frontend | ✅ | `haproxy/haproxy-frontends` | ✅ |
| `/haproxy/backends` | Backends | ✅ | `haproxy/haproxy-backends` | ✅ |
| `/haproxy/backends/:backendName` | Backend Details | ✅ | `haproxy/haproxy-backends` | ✅ |
| `/haproxy/instances` | Instances | ✅ | `haproxy/haproxy-instances` | ✅ |
| `/certificates` | TLS Certificates | ✅ | `networking/tls-certificates` | ✅ |
| `/certificates/:id` | Certificate Details | ⚠️ | (none, parent has doc) | — |
| `/dns` | DNS Zones | ✅ | `networking/dns-zones` | ✅ |

### Monitoring

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/logs` | Container Logs | ✅ | `monitoring/container-logs` | ✅ |
| `/logs/fullscreen` | Container Logs (Fullscreen) | ✅ | `monitoring/container-logs` (variant) | ✅ |
| `/monitoring` | Container Metrics | ✅ | `monitoring/container-metrics` | ✅ |
| `/events` | Events | ✅ | `monitoring/events` | ✅ |
| `/events/:id` | Event Details | ⚠️ | (none, parent has doc) | — |

### Connected Services

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/connectivity-docker` | Docker | ✅ | `connectivity/health-monitoring` | ✅ |
| `/connectivity-cloudflare` | Cloudflare | ✅ | `connectivity/health-monitoring` | ✅ |
| `/connectivity-azure` | Azure Storage | ✅ | `connectivity/health-monitoring` | ✅ |
| `/connectivity-github` | GitHub | ✅ | `connectivity/health-monitoring` | ✅ |

### Administration

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/api-keys` | API Keys | ✅ | `settings/api-keys` | ✅ |
| `/api-keys/new` | Create API Key | ⚠️ | (none, parent has doc) | — |
| `/api-keys/presets` | Permission Presets | ✅ | `settings/permission-presets` | ✅ |
| `/settings-system` | System Settings | ✅ | `settings/system-settings` | ✅ |
| `/settings-security` | Security Settings | ✅ | `settings/security-settings` | ✅ |
| `/settings-registry-credentials` | Registry Credentials | ✅ | `settings/system-settings` | ✅ |
| `/settings-self-backup` | Self-Backup Settings | ✅ | `postgres-backups/configuring-backups` | ✅ |
| `/settings-tls` | TLS Settings | ✅ | `settings/tls-settings` | ✅ |
| `/settings-ai-assistant` | AI Assistant | ✅ | `settings/ai-assistant` | ✅ |
| `/settings-self-update` | System Update | ✅ | `settings/self-update` | ✅ |

### Other (not in sidebar navigation)

| Route | Page Title | Status | helpDoc | Article Exists? |
|-------|-----------|--------|---------|-----------------|
| `/bug-report-settings` | Bug Report Settings | ✅ | `github/github-app-setup` | ✅ |
| `/user/settings` | User Settings | ✅ | `settings/user-preferences` | ✅ |

---

## Extra Docs Coverage

These articles are defined in `extra-docs-defined.md` and supplement the route-driven docs. They are not directly linked from a route `helpDoc` field.

| File | Title | Category | Status |
|------|-------|----------|--------|
| `getting-started/navigating-the-dashboard.md` | Navigating the Dashboard | getting-started | ✅ |
| `getting-started/running-with-docker.md` | Running Mini Infra with Docker | getting-started | ✅ |
| `containers/container-logs.md` | Viewing Container Logs | containers | ✅ |
| `containers/container-actions.md` | Container Actions Reference | containers | ✅ |
| `containers/troubleshooting.md` | Container Troubleshooting | containers | ✅ |
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

### api

| File | Title | Description |
|------|-------|-------------|
| `api-overview.md` | API Overview | An overview of how to use the Mini Infra REST API with API keys. |

### applications

| File | Title | Description |
|------|-------|-------------|
| `application-management.md` | Managing Applications | How to create, deploy, update, and manage applications in Mini Infra. |
| `host-stacks.md` | Host Infrastructure Stacks | How to manage host-level infrastructure stacks with plan and apply semantics in Mini Infra. |
| `stack-templates.md` | Stack Templates | How to create and manage reusable stack templates for deploying infrastructure in Mini Infra. |

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

### environments

| File | Title | Description |
|------|-------|-------------|
| `environments.md` | Managing Environments | How to create and manage environments that group services and infrastructure in Mini Infra. |

### getting-started

| File | Title | Description |
|------|-------|-------------|
| `overview.md` | Getting Started with Mini Infra | An introduction to Mini Infra and what you can do with it. |
| `navigating-the-dashboard.md` | Navigating the Dashboard | A guide to finding your way around the Mini Infra interface. |
| `running-with-docker.md` | Running Mini Infra with Docker | How to run Mini Infra using Docker or Docker Compose. |

### haproxy

| File | Title | Description |
|------|-------|-------------|
| `haproxy-overview.md` | Load Balancer Overview | An overview of how HAProxy load balancing works in Mini Infra. |
| `haproxy-frontends.md` | Managing HAProxy Frontends | How to view, create, and configure HAProxy frontends in Mini Infra. |
| `haproxy-backends.md` | Managing HAProxy Backends | How to view and configure HAProxy backends and servers in Mini Infra. |
| `haproxy-instances.md` | HAProxy Instances | How to monitor HAProxy health across environments and remediate or migrate instances in Mini Infra. |

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
| `dns-zones.md` | DNS Zones | How to view DNS zones and records from Cloudflare in Mini Infra. |

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
| `self-update.md` | System Update | How to update Mini Infra to a new version using the sidecar update mechanism. |

### tunnels

| File | Title | Description |
|------|-------|-------------|
| `tunnel-monitoring.md` | Monitoring Cloudflare Tunnels | How to monitor Cloudflare tunnel health and manage hostnames in Mini Infra. |
| `troubleshooting.md` | Cloudflare Tunnel Troubleshooting | Common issues with Cloudflare tunnel monitoring and how to resolve them. |

---

## Articles To Create

All coverage gaps have been filled. No articles remaining to create.

---

## Orphaned Docs

No orphaned docs found. Every article in `user-docs/` is either referenced by a route `helpDoc` or listed in `extra-docs-defined.md`.
