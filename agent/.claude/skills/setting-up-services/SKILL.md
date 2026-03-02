---
name: setting-up-services
description: Guide users through setting up and configuring Mini Infra services including Docker, Azure Storage, Cloudflare tunnels, GitHub App, TLS certificates, and self-backup. Use when the user asks about setup, configuration, connecting services, getting started, onboarding, or when they want to know what services are configured or what still needs to be done.
---

# Setting Up Services

You are guiding the user through configuring Mini Infra's external service integrations. Your job is to assess what is already configured, what is missing, and walk the user through each service step by step.

## Step 1: Assess Current State

Before giving any guidance, check the current connectivity status by calling:

- `GET /api/settings/connectivity/summary` — returns the latest status for each service in one compact object

The response has a `data` object keyed by service name (docker, cloudflare, azure, postgres, github-app, tls), each with `status` (connected/failed/unknown), `checkedAt`, and `errorMessage`.

Present a **compact summary** as a short bulleted list — one line per service with a checkmark or X and the service name. For Azure, also include the `defaultPostgresContainer` field from the summary to show whether the default backup container is set. For example:

- x Docker — not configured
- ✓ Azure — connected (default backup container: postgres-backups)
- ✓ Azure — connected (no default backup container set)
- x Cloudflare — not configured

Do NOT use a table. Keep it brief — the user just needs to see what's connected and what isn't at a glance. Then ask which service they'd like to set up first (or suggest the recommended order).

## Step 2: Guide Through Services

Work through services in this recommended order, since later services depend on earlier ones:

1. **Docker** (foundation - required for containers and deployments)
2. **Azure Storage** (needed for backups, TLS certificate storage)
3. **Cloudflare** (tunnel management, DNS for TLS)
4. **GitHub App** (deployments from GitHub repos)
5. **TLS Certificates** (requires Azure + Cloudflare)
6. **Self-Backup** (requires Azure)

Only guide the user through services they actually need or ask about. Don't force all services if they only want to set up one.

## Service Setup Details

### Docker

**What it does:** Connects Mini Infra to a Docker host for container management and deployments.

**Page:** `/connectivity-docker`

**What the user needs:** A Docker host connection string. Common formats:
- Local socket: `unix:///var/run/docker.sock` (Linux/Mac with Docker Desktop)
- TCP: `tcp://192.168.1.100:2375` (remote Docker host)
- Named pipe: `npipe:////./pipe/dockerDesktopLinuxEngine` (Windows)

**Check status:** `GET /api/settings/docker-host`

**Setup steps:**
1. Navigate the user to `/connectivity-docker`
2. They need to enter their Docker host address and save
3. The system will validate the connection automatically

---

### Azure Storage

**What it does:** Provides blob storage for PostgreSQL backups, TLS certificates, and self-backups.

**Page:** `/connectivity-azure`

**What the user needs:** An Azure Storage account with a connection string and 3 blob containers.

#### Creating the Azure Storage Account

Walk the user through these steps in the Azure Portal (https://portal.azure.com):

1. **Create a Storage Account:**
   - Go to **Storage accounts** > **+ Create**
   - Choose a subscription and resource group (or create a new one)
   - Pick a unique **Storage account name** (e.g., `miniinfrabackups`)
   - Choose a **Region** close to the Mini Infra server for low latency
   - **Performance**: Standard is fine
   - **Redundancy**: LRS (Locally-redundant) is sufficient for most setups; choose GRS/ZRS if you want geo-redundancy
   - Click **Review + Create** then **Create**

2. **Create 3 Blob Containers:**
   Once the storage account is created, go to **Containers** in the left sidebar and create these 3 containers:

   | Container Name | Purpose |
   |---|---|
   | `postgres-backups` | PostgreSQL database backup dumps and rollback backups |
   | `certificates` | TLS/SSL certificate PEM files for HAProxy |
   | `mini-infra-backups` | Mini Infra's own SQLite database self-backups |

   For each container:
   - Click **+ Container**
   - Enter the name
   - Set **Private access level** (no anonymous access)
   - Click **Create**

   The names above are suggestions - the user can choose their own names, but they will need to match what they configure in Mini Infra later.

3. **Get the Connection String:**
   - Go to **Security + networking** > **Access keys** in the left sidebar
   - Click **Show** next to key1
   - Copy the **Connection string** (not just the key)
   - It looks like: `DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net`

#### Connecting Azure Storage to Mini Infra

**Check status:** `GET /api/settings/azure`

**Validate:** `POST /api/settings/azure/validate`

**Setup steps:**
1. Navigate the user to `/connectivity-azure`
2. They paste their connection string and optionally the account name
3. They can test the connection before saving
4. After saving, they can browse available containers to verify the 3 containers are visible

**Important:** Remember the container names the user created - they will be needed later when configuring:
- **TLS settings** (`/settings/tls`) - select the certificates container
- **Self-backup settings** (`/settings/self-backup`) - select the self-backups container
- **Default Postgres Backup Container** - set on this same page (see below)

#### Selecting the Default Postgres Backup Container

Still on the `/connectivity-azure` page, below the container list, there is a **Default Postgres Backup Container** dropdown. This setting controls which Azure container is pre-selected when creating new PostgreSQL backup configurations.

**Setup steps:**
1. After connecting Azure Storage and verifying the containers are visible, scroll down to the **Default Postgres Backup Container** section
2. Select the postgres backups container (e.g., `postgres-backups`) from the dropdown
3. The setting saves automatically

**Check status:** `GET /api/settings?category=system&key=default_postgres_backup_container` — returns the setting if configured. The connectivity summary (`GET /api/settings/connectivity/summary`) also includes a `defaultPostgresContainer` field in the `azure` entry.

---

### Cloudflare

**What it does:** Manages Cloudflare tunnels for exposing services to the internet and DNS management for TLS certificates.

**Page:** `/connectivity-cloudflare`

**What the user needs:**
- A Cloudflare Account ID
- A Cloudflare API token with the right permissions

#### Finding the Cloudflare Account ID

1. Log in to the Cloudflare dashboard at https://dash.cloudflare.com
2. After login, the URL will be: `https://dash.cloudflare.com/<account-id>`
3. The Account ID is the 32-character hex string in the first part of the URL path right after `dash.cloudflare.com/`
4. Copy this value

#### Creating a Cloudflare API Token

1. In the Cloudflare dashboard, click your **user icon** (top right) > **My Profile**
2. Go to **API Tokens** in the left sidebar
3. Click **Create Token**
4. Click **Create Custom Token** (at the bottom, under "Custom token")
5. Configure the token permissions:
   - **Token name**: Give it a descriptive name like "Mini Infra"
   - **Permissions**:
     - Add: **Account** > **All accounts** > **Read**
     - Add: **Zone** > **DNS** > **Edit** (needed for TLS certificate DNS challenges)
     - Add: **Zone** > **Zone** > **Read**
   - **Account Resources**: Include > All accounts (or select specific account)
   - **Zone Resources**: Include > All zones (or select specific zones)
6. Click **Continue to summary** then **Create Token**
7. **Copy the token immediately** - it will only be shown once

#### Connecting Cloudflare to Mini Infra

**Check status:** `GET /api/settings/cloudflare`

**Test connectivity:** `POST /api/settings/cloudflare/test`

**Setup steps:**
1. Navigate the user to `/connectivity-cloudflare`
2. They enter their API token and Account ID
3. Test the connection
4. Once connected, they can view and manage their tunnels

---

### GitHub App

**What it does:** Enables deployments from GitHub repositories, container registry access (GHCR), and GitHub CLI access for the AI assistant.

**Page:** `/connectivity-github`

**What the user needs:** This follows a guided setup flow - the user creates a GitHub App directly from Mini Infra.

**Check status:** `GET /api/settings/github-app`

**Setup steps:**
1. Navigate the user to `/connectivity-github`
2. The page has a guided flow to create a GitHub App via manifest
3. After creating the app, they install it on their GitHub account/org
4. Then they authorize their user account via OAuth
5. Optionally, they can configure an Assistant Access token for the AI agent under the "Assistant Access" section

---

### TLS Certificates

**What it does:** Manages SSL/TLS certificates using ACME providers (Let's Encrypt, etc.), stores them in Azure Blob Storage, and deploys them to HAProxy.

**Page:** `/settings/tls`

**Prerequisites:** Azure Storage must be configured first. Cloudflare is needed if using DNS challenges.

**What the user needs:**
- An Azure Storage container to store certificates (or create one)
- An ACME email address for certificate registration
- Choice of ACME provider (Let's Encrypt recommended for production, Let's Encrypt Staging for testing)

**Check status:** `GET /api/tls/settings`

**List available containers:** `GET /api/tls/containers`

**Test container connectivity:** `POST /api/tls/connectivity/test`

**Setup steps:**
1. Verify Azure Storage is connected first
2. Navigate the user to `/settings/tls`
3. Select or specify an Azure Blob container for certificate storage
4. Choose an ACME provider (recommend Let's Encrypt for production)
5. Enter an email address for ACME account registration
6. Optionally configure the renewal schedule (default is fine for most users)

**ACME Provider options:**
- `letsencrypt` - Production certificates (recommended)
- `letsencrypt-staging` - Test certificates (for testing setup)
- `buypass` - Alternative CA
- `zerossl` - Alternative CA

---

### Self-Backup

**What it does:** Automatically backs up Mini Infra's own SQLite database to Azure Blob Storage on a schedule.

**Page:** `/settings/self-backup`

**Prerequisites:** Azure Storage must be configured first.

**What the user needs:**
- An Azure Storage container name for storing backups
- A backup schedule (cron format or common presets)
- A timezone for the schedule

**Check status:** `GET /api/settings/self-backup`

**Check schedule info:** `GET /api/settings/self-backup/schedule-info`

**Trigger manual backup:** `POST /api/settings/self-backup/trigger`

**Setup steps:**
1. Verify Azure Storage is connected first
2. Navigate the user to `/settings/self-backup`
3. Choose a backup schedule. Common presets:
   - Hourly: `0 * * * *`
   - Every 6 hours: `0 */6 * * *`
   - Daily at midnight: `0 0 * * *`
   - Daily at 2 AM: `0 2 * * *`
4. Select the Azure container for backup storage
5. Set the timezone
6. Enable the backup schedule
7. Optionally trigger a manual backup to verify everything works

## Guidance Rules

1. **Always check status first** before telling the user what to do. Don't assume anything is or isn't configured.
2. **Use UI navigation** to take users to the right page. Always call `get_current_page` first, then `navigate_to` if needed.
3. **Highlight relevant elements** when pointing out specific fields or buttons on the page.
4. **Explain prerequisites** - if a service depends on another (e.g., TLS needs Azure), tell the user and offer to set up the prerequisite first.
5. **Don't overwhelm** - if the user asks about one specific service, focus on that. Only suggest the full setup flow if they ask what needs to be done overall.
6. **Validate after setup** - after the user saves settings, check the connectivity status to confirm it worked.
7. **Be specific about what to paste** - tell users exactly where to find credentials (e.g., "Azure Portal > Storage Account > Access Keys").
