---
title: Configuring Backup Schedules
description: How to configure automated PostgreSQL backup schedules in Mini Infra.
tags:
  - postgres
  - backup
  - azure
  - cron
  - configuration
---

# Configuring Backup Schedules

Each PostgreSQL database managed by Mini Infra can have its own backup schedule. Backups run automatically using `pg_dump` and are stored in Azure Blob Storage.

## Opening the backup configuration

From the [PostgreSQL Backups](/postgres-backup) page, click the **Calendar** icon on a database row to open the backup configuration dialog.

## Backup configuration fields

### Schedule

| Field | Description |
|-------|-------------|
| **Backup Schedule** | Toggle to enable or disable automated backups |
| **Cron Schedule** | Cron expression defining when backups run (e.g., `0 2 * * *` for daily at 2 AM) |
| **Timezone** | Timezone for interpreting the cron schedule. Searchable dropdown with preview of current time. |

The next scheduled backup time is shown below the timezone field when a schedule is enabled.

### Azure Storage

| Field | Description |
|-------|-------------|
| **Container** | Azure Blob Storage container where backup files are stored |
| **Path Prefix** | Folder path within the container (defaults to the database name) |

### Backup settings

| Field | Default | Description |
|-------|---------|-------------|
| **Retention (Days)** | 30 | Number of days to keep backup files. Older backups are automatically deleted. |
| **Format** | Custom | `pg_dump` output format: Custom (compressed binary), Plain (SQL text), or TAR |
| **Compression** | 6 | Compression level 0–9 (0 = no compression, 9 = maximum compression) |

## Common cron schedules

| Schedule | Cron expression | Description |
|----------|----------------|-------------|
| Every hour | `0 * * * *` | At the start of every hour |
| Every 6 hours | `0 */6 * * *` | At midnight, 6 AM, noon, and 6 PM |
| Daily at midnight | `0 0 * * *` | Once per day at midnight |
| Daily at 2 AM | `0 2 * * *` | Once per day at 2 AM |
| Weekly (Sunday) | `0 2 * * 0` | Every Sunday at 2 AM |

## Self-backup settings

Mini Infra also backs up its own SQLite database to Azure Blob Storage. Configure this at [Settings → Self-Backup Settings](/settings-self-backup):

- **Azure Storage Container** — container for self-backup files
- **Backup Schedule** — cron expression
- **Timezone** — timezone for the schedule
- **Quick presets** — Hourly, Every 6 Hours, Daily at Midnight, Daily at 2 AM

The **Self-Backup Settings** page also shows backup history with status, file size, duration, and whether the backup was triggered manually or by the scheduler.

## Running a manual backup

To run a backup immediately without waiting for the schedule:

1. Click the **Play** icon on the database row in the backups list, or
2. Open the backup configuration dialog and click **Run Manual Backup**.

The backup appears in the **Active Operations** tab while running and moves to **History** when complete.

## What to watch out for

- Disabling the backup schedule does not delete existing backup files.
- Setting **Retention Days** to a low value will delete older backups automatically. Ensure you are not relying on backups older than the retention period for disaster recovery.
- The **Custom** format (`pg_dump -Fc`) is compressed and cannot be opened as plain text. Use the **Restore** feature to apply it.
- Backups use the **backup Docker image** configured in System Settings. If that image is not available on your host, the backup job will fail.
