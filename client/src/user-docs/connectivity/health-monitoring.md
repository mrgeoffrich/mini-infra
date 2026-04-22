---
title: Connected Services Health Monitoring
description: How to configure and monitor external service connections in Mini Infra.
tags:
  - connectivity
  - health-checks
  - docker
  - azure
  - cloudflare
  - github
  - monitoring
---

# Connected Services Health Monitoring

Mini Infra integrates with four external services: Docker, Azure Storage, Cloudflare, and GitHub. The **Connected Services** section in the sidebar has a page for each, where you configure credentials and verify connectivity.

## Docker

**Page:** [/connectivity-docker](/connectivity-docker)

Configure how Mini Infra connects to the Docker daemon.

### Configuration fields

| Field | Description |
|-------|-------------|
| **Docker Host URL** | Connection URL for the Docker daemon |
| **Docker API Version** | Docker API version to use (e.g., `1.41`) |
| **Docker Host IP Address** | IPv4 address of the Docker host, used for creating DNS A records |

### Docker Host URL examples

| Environment | URL |
|-------------|-----|
| Local socket (Linux/Mac) | `unix:///var/run/docker.sock` |
| Remote Docker daemon | `tcp://host:2376` |
| Docker Desktop (Windows) | `npipe:////./pipe/dockerDesktopLinuxEngine` |

Click **Validate & Save** (green button) to test the connection and save if successful.

---

## Azure Storage

**Page:** [/connectivity-azure](/connectivity-azure)

Configure Azure Blob Storage for PostgreSQL backups, self-backups, and TLS certificate storage.

### Configuration fields

| Field | Description |
|-------|-------------|
| **Connection String** | Azure Storage Account connection string from the Azure portal |

Find the connection string in the Azure portal under **Storage Account → Access Keys**.

Click **Validate & Save** to test and save. If connected, a list of available Azure containers appears below the form, and you can select a **Default Postgres Backup Container**.

---

## Cloudflare

**Page:** [/connectivity-cloudflare](/connectivity-cloudflare)

Configure Cloudflare API access for tunnel monitoring and DNS management.

### Configuration fields

| Field | Description |
|-------|-------------|
| **API Token** | Cloudflare API token with Cloudflare Tunnel:Edit, Zone:Read, and DNS:Edit permissions |
| **Account ID** | Your 32-character Cloudflare Account ID |

Generate an API token at `https://dash.cloudflare.com/profile/api-tokens`. Find your Account ID in the URL when logged into the Cloudflare dashboard.

---

## GitHub

**Page:** [/connectivity-github](/connectivity-github)

Connect Mini Infra to GitHub using a GitHub App for browsing packages, repositories, and workflow runs.

### Setup flow

GitHub connectivity uses a GitHub App installation:

1. Click **Connect to GitHub** — you are redirected to GitHub to review and approve the app's permissions.
2. After approval, return to Mini Infra and the setup completes automatically.
3. If the app needs to be installed on your account or organization, follow the install prompt.

### Permissions requested

The GitHub App requests **read-only** permissions for:
- Packages
- Actions
- Contents
- Metadata

### Additional tokens

Once connected, you can optionally configure:

| Token | Purpose |
|-------|---------|
| **Package Access Token** | Personal access token with `read:packages` scope — required to browse GitHub Container Registry (GHCR) packages |
| **Assistant Access Token** | Personal access token for AI agent GitHub access; can be `Read Only` or `Full Access` |

### Data visible once connected

- **Packages tab** — container images in GHCR
- **Repositories tab** — all repositories accessible to the GitHub App
- **Actions tab** — GitHub Actions workflow runs (select a repository from the dropdown)

---

## Connection validation

Each service page shows a **Validate & Save** button that tests the connection before saving. If validation fails, an error message describes the problem.

After validation, a success alert confirms the connection is active.

## What to watch out for

- Credentials are **stored encrypted** in the Mini Infra database.
- Changing connection credentials (e.g., regenerating an Azure access key) requires re-entering and re-validating them in Mini Infra.
- All features that depend on a service (backups, tunnels, deployments with DNS) stop working if that service's connection is removed or becomes invalid.
- GitHub App tokens expire. If the GitHub connection stops working, try **Test Connection** or disconnect and reconnect.
