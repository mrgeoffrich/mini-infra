---
title: Health Monitoring
description: What the Connected Services pages monitor and what each status means.
category: Connectivity
order: 1
tags:
  - connectivity
  - health
  - monitoring
  - docker
  - azure
  - cloudflare
  - github
---

# Health Monitoring

The Connected Services section in the sidebar shows the health of external services that Mini Infra depends on. Each service has its own configuration page where you can set up credentials and verify connectivity.

## How monitoring works

Mini Infra checks each configured service periodically (every 30 seconds) by making a lightweight API call or connection test. The result is cached for 5 minutes and displayed as a status badge throughout the app. The header bar shows small status dots for each service — green means connected, red means something is wrong.

## Services monitored

### Docker

**What it checks:** Whether Mini Infra can communicate with the Docker daemon through the Docker socket or configured URL.

**Configuration page:** **Docker** under Connected Services.

**Settings:**

- **Docker Host IP Address** — The IP address of your Docker host. Used when creating DNS records that point to deployed services.
- **Docker Host URL** — The Docker daemon endpoint. Common values:
  - `unix:///var/run/docker.sock` (local socket, most common)
  - `tcp://host:2376` (remote Docker over TCP)
  - `npipe:////./pipe/dockerDesktopLinuxEngine` (Windows with Docker Desktop)
- **Docker API Version** — The Docker Engine API version (e.g. `1.41`).

Click **Validate & Save** to test the connection and store the settings. If validation fails, the error message explains what went wrong.

**Status meanings:**

| Status | Meaning |
|--------|---------|
| Connected | Docker daemon is reachable and responding |
| Failed | Connection attempt returned an error |
| Timeout | Docker daemon didn't respond in time |
| Unreachable | Can't establish a connection at all |

### Azure

**What it checks:** Whether Mini Infra can authenticate with Azure Blob Storage using the configured connection string.

**Configuration page:** **Azure** under Connected Services.

**Settings:**

- **Connection String** — An Azure Storage Account connection string. Find this in the Azure Portal under Storage Account > Access Keys. The string must include `DefaultEndpointsProtocol`, `AccountName`, and `AccountKey`.

After connecting, the page shows:

- **Available Containers** — A list of blob containers in the storage account.
- **Default Postgres Backup Container** — A dropdown to select which container new backup configurations should use by default.

**Why it matters:** Azure Storage is where PostgreSQL backups are stored and where TLS certificates can be kept. If Azure is disconnected, backups will fail at the upload step.

### Cloudflare

**What it checks:** Whether Mini Infra can reach the Cloudflare API with the configured token.

**Configuration page:** **Cloudflare** under Connected Services.

**Settings:**

- **API Token** — A Cloudflare API token with permissions for tunnel management and DNS.
- **Account ID** — Your Cloudflare account ID (found in the dashboard URL).

After connecting, a link to **Tunnel Management** appears for navigating directly to the tunnels page.

**Why it matters:** Cloudflare credentials are used for tunnel monitoring and for creating DNS records during deployments.

### GitHub

**What it checks:** Whether the GitHub App installation is active and can access your account's resources.

**Configuration page:** **GitHub** under Connected Services.

GitHub uses a multi-step setup flow:

1. **Connect** — Initiates GitHub App creation via the manifest flow.
2. **Install** — Install the app on your GitHub account or organisation after it's created.
3. **Configure** — Set up a Package Access Token for GitHub Container Registry access.

Once connected, the page shows three tabs:

- **Packages** — Docker images and other packages from GitHub Container Registry.
- **Repositories** — Repositories accessible to the installed app.
- **Actions** — Recent workflow runs from your repositories.

**Why it matters:** GitHub integration provides access to container images in GHCR for deployments, and gives visibility into repository activity and CI/CD runs.

## Status indicators across the app

The header bar shows compact status dots for all configured services. These update automatically and give you an at-a-glance view of infrastructure health. Click any dot to navigate to that service's configuration page.

Each service status card on the configuration pages shows:

- Connection status badge with response time.
- When the last check ran (e.g. "2 minutes ago").
- Last successful connection time.
- Error message and error code if the connection is failing.

## What to watch out for

- A service showing as "connected" means Mini Infra can reach the API. It doesn't guarantee that all operations will succeed — for example, Azure may be connected but a specific container might have restricted permissions.
- Status checks are cached for 5 minutes. If you fix a connectivity issue, it may take up to 5 minutes for the status to update, or you can click the refresh button on the service's page.
- If Docker shows as unreachable, most features in Mini Infra will be impaired — containers, deployments, and backups all depend on Docker access.
