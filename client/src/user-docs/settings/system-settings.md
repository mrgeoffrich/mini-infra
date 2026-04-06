---
title: System Settings
description: How to configure system-wide settings including Docker images, HAProxy ports, and event retention.
tags:
  - settings
  - configuration
  - docker
  - haproxy
  - postgres
---

# System Settings

The **System Settings** page at [/settings-system](/settings-system) controls system-wide configuration for backup and restore operations, HAProxy port overrides, Docker host networking, and event retention.

## Production Mode

Toggle **Production System** to mark this as a production Mini Infra instance. This is for display purposes only and does not change system behavior.

## Backup Container Settings

| Field | Description |
|-------|-------------|
| **Docker Image** | Docker image used to run `pg_dump` backup operations (e.g., `postgres:15-alpine`) |

Mini Infra pulls this image and runs it as a temporary container whenever a database backup is triggered.

## Restore Container Settings

| Field | Description |
|-------|-------------|
| **Docker Image** | Docker image used to run `pg_restore` restore operations (e.g., `postgres:15-alpine`) |

Use the same major version as your PostgreSQL server for compatibility.

## HAProxy Port Configuration

By default, Mini Infra uses different ports depending on whether deployments are exposed to the local network or the internet:

| Context | HTTP port | HTTPS port |
|---------|-----------|------------|
| Local network | 80 | 443 |
| Internet-facing | 8111 | 8443 |

You can override these with custom values:

| Field | Description |
|-------|-------------|
| **HTTP Port** | Custom port for HTTP traffic (1–65535). Leave empty for the default. |
| **HTTPS Port** | Custom port for HTTPS traffic (1–65535). Leave empty for the default. |

Port overrides apply to all HAProxy deployments across all environments.

## Docker Host Network Configuration

| Field | Description |
|-------|-------------|
| **Docker Host IP Address** | IPv4 address of the Docker host, used when creating DNS A records for deployment hostnames |

This must be a valid IPv4 address, either local (e.g., `192.168.1.100`) or public (e.g., `203.0.113.1`). This value is also configurable on the Docker connectivity page.

## User Events Configuration

Events track long-running operations. Old events are automatically cleaned up:

| Field | Default | Description |
|-------|---------|-------------|
| **Event Retention Period (Days)** | 30 | Events older than this many days are deleted. Range: 1–365. |

Automatic cleanup runs daily at 2 AM UTC.

## Default Postgres Backup Container

Select a default Azure Blob Storage container for PostgreSQL database backups. This pre-populates the container dropdown when configuring individual database backup schedules.

## Registry Credentials

The **Registry Credentials** page at [/settings-registry-credentials](/settings-registry-credentials) manages Docker registry authentication.

Each credential entry has:

| Field | Description |
|-------|-------------|
| **Name** | Friendly name (e.g., `GitHub Container Registry`) |
| **Registry URL** | Docker registry hostname (e.g., `ghcr.io`) — cannot be changed after creation |
| **Username** | Registry username |
| **Password** | Registry password or personal access token (stored encrypted) |
| **Description** | Optional notes |
| **Default** | Whether this is the default registry credential |
| **Active** | Whether the credential is enabled |

Credentials are automatically applied to container pulls, deployments, backups, and restore operations.

### Managing credentials

- **Test Connection** — verify the credentials are valid
- **Set as Default** — make this the default registry
- **Edit** — update the name, username, password, or description
- **Delete** — remove the credential (requires confirmation; active deployments using this registry will fail)

## What to watch out for

- The backup and restore Docker images must match your PostgreSQL server's **major version**. A `postgres:15-alpine` image cannot restore a backup from a PostgreSQL 16 server.
- Changing HAProxy port overrides affects all running environments — existing traffic routing may be disrupted.
- Reducing the **Event Retention Period** will cause events older than the new value to be deleted at the next cleanup run.
