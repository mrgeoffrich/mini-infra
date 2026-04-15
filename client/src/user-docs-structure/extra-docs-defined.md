# Extra Docs Definitions

These pages supplement the route-driven docs catalogued in `user-docs-structure.md`. Add entries here for articles that should exist in the help system but aren't directly linked from a route `helpDoc` field — for example, deeper sub-topic articles, troubleshooting guides, and standalone reference material.

Each entry is consumed by the `write-user-docs` skill to generate the actual article.

---

## getting-started/navigating-the-dashboard.md

**Title**: Navigating the Dashboard
**Category**: getting-started
**Order**: 2

**Content to cover**:
- Overview of the sidebar navigation layout and sections (Applications, Databases, Networking, Monitoring, Connected Services, Administration)
- How to use the breadcrumb trail to understand your current location
- How to open the contextual help panel from any page (the help icon)
- The dark/light mode toggle and where it lives
- The user settings menu (top-right avatar/menu)
- How to return to the dashboard from any page

---

## getting-started/running-with-docker.md

**Title**: Running Mini Infra with Docker
**Category**: getting-started
**Order**: 3

**Content to cover**:
- Prerequisites: a Linux host with Docker installed
- Pulling the image from `ghcr.io/mrgeoffrich/mini-infra:latest`
- The Docker socket mount (`/var/run/docker.sock`) and why it is needed
- Persistent data volumes (`mini-infra-data` for the SQLite database, `mini-infra-logs` for logs)
- Example `docker-compose.yml` snippet
- How to check that the application started correctly (health check endpoint, `docker logs`)
- Security note about Docker socket access and trusted-environment recommendation

---

## containers/container-logs.md

**Title**: Viewing Container Logs
**Category**: containers
**Order**: 3

**Content to cover**:
- How to open the logs view from the container detail page
- Log streaming — logs update in real-time while the container is running
- How to filter / search within the log output
- The difference between stdout and stderr in the log stream
- Downloading or copying log output
- What to do when logs are not appearing (container stopped, log driver not supported)

---

## containers/container-actions.md

**Title**: Container Actions Reference
**Category**: containers
**Order**: 4

**Content to cover**:
- List of available actions: Start, Stop, Restart, Pause, Unpause, Remove
- Which actions are available depending on the container's current state (running, stopped, paused, exited)
- What happens when you remove a container (data loss warning for non-volume data)
- Pulling a new image version and recreating the container
- The confirmation dialogs and when they appear
- Executing a command inside a running container (exec/shell access if available)

---

## containers/troubleshooting.md

**Title**: Container Troubleshooting
**Category**: containers
**Order**: 5

**Content to cover**:
- Container stuck in "Restarting" loop — how to check logs and identify the cause
- Container shows as "Exited" — reading the exit code and what common codes mean (0, 1, 137, 143)
- "Permission denied" errors when accessing Docker socket
- Container not visible in Mini Infra but present in `docker ps` — cache refresh and filtering
- Image pull failures — registry connectivity, authentication (see Registry Credentials)
- Volume mount errors

---

## postgres-backups/database-management.md

**Title**: Managing PostgreSQL Databases
**Category**: postgres-backups
**Order**: 4

**Content to cover**:
- Navigating from the Postgres Servers list to a specific server's detail page
- Viewing the list of databases on a server
- Opening a database detail page — what information is shown (size, backup status, last backup time)
- Connection details shown on the database detail page
- Relationship between the Postgres Servers pages and the Postgres Backups pages
- How backup schedules are associated with individual databases

---

## postgres-backups/troubleshooting.md

**Title**: PostgreSQL Backup Troubleshooting
**Category**: postgres-backups
**Order**: 5

**Content to cover**:
- Backup job shows as failed — checking the server connectivity on the Docker connectivity page
- "Connection refused" to PostgreSQL — firewall rules, pg_hba.conf, host/port configuration
- Azure Storage upload failing — checking Azure connectivity and credentials in Connected Services
- Restore fails partway through — partial restore state and how to clean up
- Backup file not found during restore — checking Azure container and blob name
- Schedule not triggering — verifying cron expression format and server timezone setting

---

## tunnels/troubleshooting.md

**Title**: Cloudflare Tunnel Troubleshooting
**Category**: tunnels
**Order**: 2

**Content to cover**:
- Tunnel shows as "Inactive" or "Degraded" — checking the `cloudflared` daemon on the host
- No tunnels listed — verifying Cloudflare API token scope and zone/account IDs in Settings
- Tunnel health indicators explained: what Active, Inactive, Degraded, and Down mean
- Connector count — what it means when a tunnel has 0 connectors
- Latency spikes in the monitoring view — when to investigate vs. when they are transient
- Relationship between tunnels and the Cloudflare connectivity check

---

## connectivity/troubleshooting.md

**Title**: Connected Services Troubleshooting
**Category**: connectivity
**Order**: 2

**Content to cover**:
- Understanding the connectivity status indicators: Connected, Degraded, Disconnected, Not Configured
- Docker connectivity failing — socket permissions, Docker daemon not running
- Cloudflare connectivity failing — API token invalid or expired, rate limiting
- Azure Storage connectivity failing — SAS token expired, wrong account name or container
- GitHub connectivity failing — GitHub App not installed, private key mismatch, app suspended
- How to re-test connectivity after updating credentials (the "Test Connection" button)
- Where credentials are stored and how to update them

---

## github/packages-and-registries.md

**Title**: GitHub Packages and Container Registries
**Category**: github
**Order**: 2

**Content to cover**:
- How Mini Infra uses the GitHub Container Registry (ghcr.io) for pulling private images
- Linking the GitHub App to registry access
- Configuring registry credentials in the Registry Credentials settings page
- How authentication tokens are refreshed
- Pulling images from `ghcr.io` in deployment configurations
- Troubleshooting "unauthorized" errors when pulling from ghcr.io

---

## github/repository-integration.md

**Title**: GitHub Repository Integration
**Category**: github
**Order**: 3

**Content to cover**:
- What the GitHub App integration provides: access to repos, packages, and Actions
- Which GitHub App permissions are required (Contents: read, Packages: read, Actions: read)
- How to view which repositories the app is installed on
- Repository webhooks — if Mini Infra listens for push events to trigger deployments
- Viewing recent Actions workflow runs related to deployments
- Revoking or reinstalling the GitHub App

---

## github/troubleshooting.md

**Title**: GitHub Integration Troubleshooting
**Category**: github
**Order**: 4

**Content to cover**:
- GitHub App not appearing after installation — checking the App ID and private key in settings
- "Resource not accessible by integration" — missing GitHub App permissions
- Webhook deliveries failing — correct webhook URL and secret
- Bug report submission failing — GitHub App needs Issues: write permission
- Private key format issues — PEM format requirements
- Rate limiting from the GitHub API — what Mini Infra does when rate limited

---

## api/api-overview.md

**Title**: API Overview
**Category**: api
**Order**: 1

**Content to cover**:
- Mini Infra exposes a REST API for automation and scripting
- Authentication: API keys created on the API Keys page, passed as `Authorization: Bearer <key>` or `x-api-key: <key>` header
- API key scopes and permission presets — how to create a read-only or scoped key
- Base URL: same host and port as the web interface (e.g. `http://your-host:5000/api/`)
- Key resource groups available: `/api/containers`, `/api/deployments`, `/api/postgres-backup`, `/api/tunnels`, `/api/events`
- Rate limiting and error response format (JSON `{ error: string }`)
- Link to the system settings page for the API key secret configuration

---
