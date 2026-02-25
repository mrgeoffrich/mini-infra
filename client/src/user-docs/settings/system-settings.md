---
title: System Settings
description: Docker image configuration, HAProxy ports, event retention, and other system-level settings.
category: Settings
order: 1
tags:
  - settings
  - system
  - configuration
  - docker
  - haproxy
  - backup
---

# System Settings

System Settings controls infrastructure-level configuration that affects how Mini Infra operates. Navigate to **System Settings** under Administration in the sidebar.

## Production mode

A toggle at the top of the page controls whether this instance is considered a production environment. Production mode is informational — it displays a visual indicator in the UI so you can distinguish production from development or staging instances.

## Backup and restore Docker images

Mini Infra runs PostgreSQL backup and restore operations inside temporary Docker containers. You need to tell it which Docker images to use:

- **Backup Docker Image** — The image used for `pg_dump`. Set this to a PostgreSQL image matching your database version (e.g. `postgres:16`).
- **Restore Docker Image** — The image used for `pg_restore`. Typically the same image as backup.

If these aren't set, the PostgreSQL Backups page shows an alert prompting you to configure them. Backups and restores will fail without valid images.

## HAProxy port configuration

By default, HAProxy listens on standard ports:

- **HTTP Port** — Port 80 for local networks, port 8111 for internet-facing environments.
- **HTTPS Port** — Port 443 for local networks, port 8443 for internet-facing environments.

You can override these ports if the defaults conflict with other services on the host. The port configuration depends on the environment's network type (local or internet), which is set when creating an environment.

## Docker host IP address

The IP address of your Docker host, used when creating DNS records that point to deployed services. Set this to the IP that external clients should use to reach the host — either a local network IP (e.g. `192.168.1.100`) or a public IP.

This is the same setting available on the Docker connectivity page. Changing it in either place updates the same value.

## User events configuration

- **Retention Days** — How many days to keep event records before automatic cleanup. Default is 30, range is 1–365. Events older than this are deleted by a daily cleanup job.

## Default Postgres backup container

A dropdown to pre-select the Azure Blob Storage container used for new backup configurations. This saves time when setting up multiple databases — the container is pre-filled in the backup configuration dialog.

This setting only appears when Azure Storage is connected. If Azure isn't configured, you'll see a prompt to set it up first.

## Security settings

The **Security** page (separate from System Settings) manages two critical secrets:

- **Session Secret** — Used to sign user session tokens. Regenerating it immediately invalidates all active sessions, forcing every user to log in again.
- **API Key Secret** — Used to hash API keys. Regenerating it invalidates all existing API keys — they won't authenticate until new keys are created.

Both secrets are displayed in masked form. Regeneration requires confirmation because of the immediate, system-wide impact.

## Registry credentials

The **Registry Credentials** page manages Docker registry authentication for pulling images during deployments and backup operations:

- **Name** — A descriptive label for the credential.
- **Registry URL** — The registry hostname (e.g. `ghcr.io`, `docker.io`, `registry.example.com`). Cannot be changed after creation.
- **Username** and **Password** — Registry authentication credentials. Passwords are encrypted at rest.
- **Default** — One credential can be marked as the default, used when no specific registry is configured on a deployment.

Each credential has a test connection button to verify it can authenticate with the registry. Credentials are matched to deployments by registry URL.

## Self-backup

The **Self-Backup** page backs up Mini Infra's own SQLite database to Azure Blob Storage:

- **Azure Container** — Which storage container to use.
- **Schedule** — A cron expression for automatic backups, with preset options (hourly, every 6 hours, daily, weekly).
- **Timezone** — For interpreting the schedule.
- **Enable/Disable** — Toggle automatic backups on or off.
- **Backup Now** — Trigger an immediate backup.
- **Backup History** — Table of past backups with status, file size, duration, and download links.

This is separate from PostgreSQL database backups — it protects Mini Infra's own configuration and state.

## TLS certificate settings

The **TLS Settings** page configures automatic SSL/TLS certificate management:

- **Certificate Storage** — Azure Blob Storage container for storing certificates. Uses the same Azure connection configured for backups.
- **ACME Provider** — Let's Encrypt Production (real certificates) or Let's Encrypt Staging (test certificates that browsers won't trust, but useful for testing without hitting rate limits).
- **Email Address** — Required by Let's Encrypt for expiry notifications and account recovery.
- **Renewal Schedule** — A cron expression for when to check certificate expiry (default: daily at 2 AM).
- **Renewal Days Before Expiry** — How many days before expiry to trigger renewal (default: 30).

## GitHub settings

The **GitHub Settings** page configures a separate GitHub integration for bug reporting:

- **Personal Access Token** — A GitHub PAT with `repo` and `issues:write` scopes.
- **Repository Owner** and **Repository Name** — Where bug report issues are created.

This is independent of the GitHub App integration for packages and repositories. It uses a personal token rather than a GitHub App.

## What to watch out for

- Changing Docker images for backup/restore affects all future backup and restore operations. Existing backups in Azure are not affected.
- Regenerating the session secret logs out every user immediately. Regenerating the API key secret breaks every existing API key.
- HAProxy port changes take effect on the next environment start. Running environments continue using their current ports until restarted.
- Self-backup requires Azure Storage to be configured first. If Azure connectivity fails, self-backups will also fail.
