---
title: PostgreSQL Backup Overview
description: An overview of how PostgreSQL backup management works in Mini Infra.
tags:
  - postgres
  - backup
  - azure
  - monitoring
---

# PostgreSQL Backup Overview

Mini Infra lets you connect to PostgreSQL servers, manage their databases, and schedule automated backups to Azure Blob Storage. Backups run inside short-lived Docker containers using `pg_dump` and are stored as compressed files in Azure.

## Prerequisites

Before using PostgreSQL backup features you need:

1. **Azure Blob Storage** — configured at [Connected Services → Azure Storage](/connectivity-azure). Backups are stored in Azure containers.
2. **Docker PostgreSQL images** — configured at [Settings → System Settings](/settings-system). Mini Infra uses these images to run backup and restore operations.
3. **Docker connected** — the Docker daemon must be connected so Mini Infra can launch backup containers.

If these are not configured, an alert appears on the PostgreSQL pages with a link to the relevant settings.

## PostgreSQL Servers page

Go to [/postgres-server](/postgres-server) to manage PostgreSQL servers. Each server represents a connection to a PostgreSQL instance.

## PostgreSQL Backups page

Go to [/postgres-backup](/postgres-backup) to view backup configurations and history for all databases.

## Database table

The database list shows:

| Column | Description |
|--------|-------------|
| **Name** | Configuration name for this database connection |
| **Host** | Server hostname and port |
| **Database** | Name of the PostgreSQL database |
| **Status** | Connection health status |
| **Backup Status** | Whether backups are configured and scheduled |
| **Next Backup** | Scheduled time of the next backup, or "Not scheduled" |

### Health status values

| Status | Meaning |
|--------|---------|
| `Healthy` | Connection is working |
| `Unhealthy` | Connection failed — check credentials and network |
| `Unknown` | Status has not been checked yet |

### Backup status values

| Status | Meaning |
|--------|---------|
| `Scheduled` | Backups are enabled with a cron schedule |
| `Disabled` | Backup configuration exists but is disabled |
| `Not Configured` | No backup configuration has been set up |

## Actions per database

Each database row in the list has action buttons:

| Button | Action |
|--------|--------|
| Play icon | Run a manual backup immediately |
| Calendar icon | Configure backup schedule and settings |
| Download icon | Browse existing backups and restore |
| Pencil icon | Edit the database connection |
| Trash icon | Delete the database connection |

## Backup progress and history

The bottom of the PostgreSQL pages shows:

- **Active Operations** — currently running backups with live progress
- **History** — completed and failed backup operations with timestamps, file names, sizes, and durations

## What to watch out for

- Azure Blob Storage must be connected and a container must be selected before backups can run.
- Backup operations run inside Docker containers. If Docker is not connected or the configured backup image is not available, backups will fail.
- Backups are stored indefinitely unless you configure a **Retention Days** limit in the backup configuration.
