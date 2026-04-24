# User Docs Structure

Generated: 2026-04-24

## Coverage Summary

- Total user-visible routes: 56
- Routes fully covered: 55 ✅
- Routes partially covered / inferred: 1 ⚠️
- Routes missing coverage: 0 ❌
- Extra defined articles (from extra-docs-defined.md): 13 total, 13 ✅ exist, 0 ❌ not yet created

_Updated after write-user-docs session: 6 new articles written for `/system-diagnostics`, `/settings-users`, `/settings-authentication`, `/vault`, `/vault/policies`, `/vault/approles`. helpDoc fields wired in route-config.ts._

---

## Route Coverage by Section

### Dashboard

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/dashboard` | Dashboard | ✅ | `getting-started/overview.md` |

### Applications

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/applications` | Applications | ✅ | `applications/application-management.md` |
| `/applications/new` | New Application | ✅ | `applications/application-management.md` |
| `/applications/:id` | Application Details | ✅ | `applications/application-management.md` |
| `/environments` | Environments | ✅ | `environments/environments.md` |
| `/environments/:id` | Environment Details | ⚠️ | `environments/environments.md` (parent doc) |
| `/stack-templates` | Stack Templates | ✅ | `applications/stack-templates.md` |
| `/stack-templates/:templateId` | Stack Template | ✅ | `applications/stack-templates.md` |
| `/containers` | Containers | ✅ | `containers/viewing-containers.md` |
| `/containers/:id` | Container Details | ✅ | `containers/managing-containers.md` |
| `/containers/volumes/:name/inspect` | Volume Inspect | ✅ | `containers/volume-management.md` |
| `/containers/volumes/:name/files/*` | Volume File Content | ✅ | `containers/volume-management.md` |

### Databases

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/postgres-server` | Postgres Servers | ✅ | `postgres-backups/backup-overview.md` |
| `/postgres-server/:serverId` | Server Details | ⚠️ | `postgres-backups/backup-overview.md` (parent doc) |
| `/postgres-server/:serverId/databases/:dbId` | Database Details | ✅ | `postgres-backups/database-management.md` |
| `/postgres-backup` | Postgres Backups | ✅ | `postgres-backups/backup-overview.md` |
| `/postgres-backup/:databaseId/restore` | Restore Database | ✅ | `postgres-backups/restoring-backups.md` |

### Monitoring

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/logs` | Container Logs | ✅ | `monitoring/container-logs.md` |
| `/monitoring` | Container Metrics | ✅ | `monitoring/container-metrics.md` |
| `/events` | Events | ✅ | `monitoring/events.md` |
| `/events/:id` | Event Details | ⚠️ | `monitoring/events.md` (parent doc) |

### Networking

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/tunnels` | Cloudflare Tunnels | ✅ | `tunnels/tunnel-monitoring.md` |
| `/haproxy` | Load Balancer | ✅ | `haproxy/haproxy-overview.md` |
| `/haproxy/frontends` | Frontends | ✅ | `haproxy/haproxy-frontends.md` |
| `/haproxy/frontends/new/manual` | Connect Container | ✅ | `haproxy/haproxy-frontends.md` |
| `/haproxy/frontends/:frontendName` | Frontend Details | ✅ | `haproxy/haproxy-frontends.md` |
| `/haproxy/frontends/:frontendName/edit` | Edit Frontend | ✅ | `haproxy/haproxy-frontends.md` |
| `/haproxy/backends` | Backends | ✅ | `haproxy/haproxy-backends.md` |
| `/haproxy/backends/:backendName` | Backend Details | ✅ | `haproxy/haproxy-backends.md` |
| `/haproxy/instances` | Instances | ✅ | `haproxy/haproxy-instances.md` |
| `/certificates` | TLS Certificates | ✅ | `networking/tls-certificates.md` |
| `/certificates/:id` | Certificate Details | ⚠️ | `networking/tls-certificates.md` (parent doc) |
| `/dns` | DNS Zones | ✅ | `networking/dns-zones.md` |

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
| `/api-keys/new` | Create API Key | ⚠️ | `settings/api-keys.md` (parent doc) |
| `/api-keys/presets` | Permission Presets | ✅ | `settings/permission-presets.md` |
| `/settings-system` | System Settings | ✅ | `settings/system-settings.md` |
| `/settings-registry-credentials` | Registry Credentials | ✅ | `settings/system-settings.md` |
| `/settings-self-backup` | Self-Backup Settings | ✅ | `postgres-backups/configuring-backups.md` |
| `/settings-tls` | TLS Settings | ✅ | `settings/tls-settings.md` |
| `/settings-ai-assistant` | AI Assistant | ✅ | `settings/ai-assistant.md` |
| `/system-diagnostics` | System Diagnostics | ✅ | `settings/system-diagnostics.md` |
| `/settings-self-update` | System Update | ✅ | `settings/self-update.md` |
| `/settings-users` | Users | ✅ | `settings/user-management.md` |
| `/settings-authentication` | Authentication | ✅ | `settings/authentication.md` |
| `/vault` | Vault | ✅ | `vault/vault-overview.md` |
| `/vault/policies` | Vault Policies | ✅ | `vault/vault-policies.md` |
| `/vault/policies/:id` | Vault Policy | ✅ | `vault/vault-policies.md` |
| `/vault/approles` | Vault AppRoles | ✅ | `vault/vault-approles.md` |
| `/vault/approles/:id` | Vault AppRole | ✅ | `vault/vault-approles.md` |

### Other (Non-nav routes)

| Route | Page Title | Status | Doc File |
|-------|-----------|--------|----------|
| `/bug-report-settings` | Bug Report Settings | ✅ | `github/github-app-setup.md` |
| `/user/settings` | User Settings | ✅ | `settings/user-preferences.md` |

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
| `application-management.md` | Managing Applications | How to create, deploy, update, and manage applications in Mini Infra |
| `host-stacks.md` | Host Infrastructure Stacks | How to manage host-level infrastructure stacks with plan and apply semantics in Mini Infra. |
| `stack-templates.md` | Stack Templates | How to create and manage reusable stack templates for deploying infrastructure in Mini Infra |

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
| `environments.md` | Managing Environments | How to create and manage environments that group services and infrastructure in Mini Infra |

### getting-started

| File | Title | Description |
|------|-------|-------------|
| `concepts.md` | Concepts and Terminology | A glossary of Mini Infra concepts — what each feature is, how it works, and the terminology used throughout the application. |
| `navigating-the-dashboard.md` | Navigating the Dashboard | A guide to finding your way around the Mini Infra interface. |
| `overview.md` | Getting Started with Mini Infra | An introduction to Mini Infra and what you can do with it. |
| `running-with-docker.md` | Running Mini Infra with Docker | How to run Mini Infra using Docker or Docker Compose. |

### github

| File | Title | Description |
|------|-------|-------------|
| `github-app-setup.md` | Setting Up the GitHub App | How to connect Mini Infra to GitHub using the GitHub App integration. |
| `packages-and-registries.md` | GitHub Packages and Container Registries | How to browse GitHub Container Registry packages connected through the GitHub App. |
| `repository-integration.md` | GitHub Repository Integration | How to view repositories, monitor GitHub Actions, and configure bug reporting with GitHub. |
| `troubleshooting.md` | GitHub Integration Troubleshooting | Common GitHub integration issues and how to resolve them. |

### haproxy

| File | Title | Description |
|------|-------|-------------|
| `haproxy-overview.md` | Load Balancer Overview | An overview of how HAProxy load balancing works in Mini Infra. |
| `haproxy-frontends.md` | Managing HAProxy Frontends | How to view, create, and configure HAProxy frontends in Mini Infra |
| `haproxy-backends.md` | Managing HAProxy Backends | How to view and configure HAProxy backends and servers in Mini Infra |
| `haproxy-instances.md` | HAProxy Instances | How to monitor HAProxy health across environments and remediate or migrate instances in Mini Infra |

### monitoring

| File | Title | Description |
|------|-------|-------------|
| `container-logs.md` | Searching Container Logs | How to search, filter, and stream centralized container logs in Mini Infra. |
| `container-metrics.md` | Container Metrics | How to monitor CPU, memory, and network usage across Docker containers in Mini Infra. |
| `events.md` | Event Log | How to view and manage the system event log in Mini Infra. |

### networking

| File | Title | Description |
|------|-------|-------------|
| `dns-zones.md` | DNS Zones | How to view DNS zones and records from Cloudflare in Mini Infra |
| `tls-certificates.md` | TLS Certificate Management | How to issue, renew, and manage SSL/TLS certificates in Mini Infra. |

### postgres-backups

| File | Title | Description |
|------|-------|-------------|
| `backup-overview.md` | PostgreSQL Backup Overview | An overview of how PostgreSQL backup management works in Mini Infra. |
| `configuring-backups.md` | Configuring Backup Schedules | How to configure automated PostgreSQL backup schedules in Mini Infra. |
| `database-management.md` | Managing PostgreSQL Databases | How to add, edit, and manage PostgreSQL database connections in Mini Infra. |
| `restoring-backups.md` | Restoring a PostgreSQL Backup | How to browse backups and restore a PostgreSQL database in Mini Infra. |
| `troubleshooting.md` | PostgreSQL Backup Troubleshooting | Common PostgreSQL backup and restore issues and how to resolve them. |

### settings

| File | Title | Description |
|------|-------|-------------|
| `ai-assistant.md` | AI Assistant Settings | How to configure the AI assistant's API key, model, and view its capabilities in Mini Infra. |
| `api-keys.md` | Managing API Keys | How to create, manage, and revoke API keys for programmatic access to Mini Infra. |
| `authentication.md` | Authentication Configuration | How to configure authentication methods including Google OAuth in Mini Infra. |
| `permission-presets.md` | API Key Permission Presets | How to create and manage reusable permission templates for API keys. |
| `self-update.md` | System Update | How to update Mini Infra to a new version using the sidecar update mechanism |
| `system-diagnostics.md` | System Diagnostics | How to read server memory statistics and capture diagnostic artifacts in Mini Infra. |
| `system-settings.md` | System Settings | How to configure system-wide settings including Docker images, HAProxy ports, and event retention. |
| `tls-settings.md` | TLS Settings | How to configure certificate storage, ACME provider, and renewal scheduling for TLS certificates. |
| `user-management.md` | User Management | How to create, delete, and manage user accounts and passwords in Mini Infra. |
| `user-preferences.md` | User Preferences | How to configure personal settings like timezone in Mini Infra. |

### tunnels

| File | Title | Description |
|------|-------|-------------|
| `tunnel-monitoring.md` | Monitoring Cloudflare Tunnels | How to monitor Cloudflare tunnel health and manage hostnames in Mini Infra. |
| `troubleshooting.md` | Cloudflare Tunnel Troubleshooting | Common issues with Cloudflare tunnel monitoring and how to resolve them. |

### vault

| File | Title | Description |
|------|-------|-------------|
| `vault-overview.md` | Vault Overview | An overview of the managed OpenBao secrets vault — bootstrap, seal state, and operator credentials. |
| `vault-policies.md` | Managing Vault Policies | How to create, edit, publish, and delete HCL policy documents for the managed Vault. |
| `vault-approles.md` | Managing Vault AppRoles | How to create, apply, and manage Vault AppRole credentials for applications. |

---

## Proposed New Articles

All coverage gaps have been filled. No articles remaining to create.

---

## Extra Docs Still To Create

All extra articles defined in `extra-docs-defined.md` already exist in `client/src/user-docs/`. Nothing to create here.

---

## Orphaned Docs

Docs that exist in `user-docs/` but are not referenced by any route in route-config.ts AND are not listed in extra-docs-defined.md:

| File | Title | Notes |
|------|-------|-------|
| `applications/host-stacks.md` | Host Infrastructure Stacks | No route has a `helpDoc` pointing to this file and it is not in extra-docs-defined.md. Stacks are accessed through Applications/Environments — consider adding to extra-docs-defined.md or wiring a helpDoc. |
| `getting-started/concepts.md` | Concepts and Terminology | No route links here and it is not in extra-docs-defined.md. Useful reference material — consider adding to extra-docs-defined.md to intentionally catalogue it. |
