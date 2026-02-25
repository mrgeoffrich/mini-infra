---
title: Backup Overview
description: How the PostgreSQL backup system works end-to-end — scheduling, storage, and monitoring.
category: PostgreSQL Backups
order: 1
tags:
  - postgres
  - backups
  - azure
  - scheduling
  - overview
---

# Backup Overview

Mini Infra can schedule and run automated backups of PostgreSQL databases, store them in Azure Blob Storage, and restore them on demand.

## How it works

The backup system has four parts:

1. **Database connections** — You register PostgreSQL servers and databases with Mini Infra by providing connection details (host, port, credentials). Mini Infra tests the connection before saving it.
2. **Backup scheduling** — Each database can have an independent backup schedule defined as a cron expression with timezone support. Schedules run via node-cron on the server.
3. **Backup execution** — When a backup runs (scheduled or manual), Mini Infra spins up a temporary Docker container with `pg_dump`, connects it to your PostgreSQL server over a Docker network, dumps the database, and uploads the result to Azure Blob Storage.
4. **Restore** — You browse available backups in Azure, pick one, and Mini Infra runs `pg_restore` in another temporary Docker container to load the data back into the original database or a new one.

## What you need before starting

Before you can configure backups, two things must be set up:

- **Azure Storage connection** — A valid Azure Blob Storage connection string must be configured on the **Azure** page under Connected Services. This is where backup files are stored.
- **Docker images for pg_dump and pg_restore** — The backup and restore operations run inside Docker containers. You need to specify which PostgreSQL Docker images to use in **System Settings** under Administration. If these aren't configured, the PostgreSQL Backups page shows an alert prompting you to set them up.

## The PostgreSQL Backups page

Navigate to **PostgreSQL Backups** in the sidebar. The page shows:

- **Database Connections table** — Every registered database with its name, host, health status, backup status, and next scheduled backup time.
- **Active Operations tab** — Real-time progress for any running backup or restore operations, including progress bars, step counters, and time estimates.
- **History tab** — A searchable log of past backup and restore operations with status, duration, size, and error details.

## Health status

Mini Infra periodically checks each database connection. The health column shows:

| Status | Meaning |
|--------|---------|
| **Healthy** | Connection test succeeded recently |
| **Unhealthy** | Connection test failed — check credentials, network, or whether the server is running |
| **Unknown** | No health check has run yet |

## Backup status

Each database shows one of three backup states:

| Status | Meaning |
|--------|---------|
| **Scheduled** | Automated backups are enabled and running on a cron schedule |
| **Disabled** | A backup configuration exists but the schedule is turned off |
| **Not Configured** | No backup configuration has been created for this database |

## What to watch out for

- Backups use Docker containers internally. If the Docker daemon is unreachable, backups will fail.
- The backup Docker image must match (or be compatible with) the PostgreSQL version of the target database. A pg_dump from PostgreSQL 16 may not work against a PostgreSQL 12 server.
- Large databases take longer to back up and produce larger files in Azure. Monitor the Active Operations tab to track progress.
- Backup operations have a 2-hour timeout. If a backup hasn't completed within that window, it's marked as failed.
