---
title: Restoring a PostgreSQL Backup
description: How to browse backups and restore a PostgreSQL database in Mini Infra.
category: PostgreSQL Backups
order: 3
tags:
  - postgres
  - backup
  - restore
  - azure
---

# Restoring a PostgreSQL Backup

Mini Infra lets you browse your Azure Blob Storage backups and restore them to an existing database or a new database.

## Opening the restore page

From the [PostgreSQL Backups](/postgres-backup) page, click the **Download** icon on a database row to open the restore page at `/postgres-backup/:databaseId/restore`.

## Browsing available backups

The **Browse Backups** tab lists all backup files stored in the configured Azure container for this database. Each row shows:

| Column | Description |
|--------|-------------|
| **Backup Name** | File name of the backup archive |
| **Created** | Date and time the backup was created |
| **Size** | File size |
| **Actions** | Restore button |

Click **Restore** on any backup to open the restore confirmation dialog.

## Restore confirmation dialog

Before restoring, you must choose where to restore to:

### Option 1 — Overwrite the existing database

Replaces all data in the existing database with the contents of the backup. This is the most common option for disaster recovery.

> **Warning: This cannot be undone.** All current data in the database is replaced by the backup.

### Option 2 — Restore to a new database

Creates a new database and populates it with the backup data. The existing database is not affected. You must enter a name for the new database.

The dialog also shows:
- Backup file name, creation date, and size
- Estimated restore time (based on file size)

After choosing your option, click **Overwrite Database** or **Create & Restore** to start the restore.

## Monitoring a restore

The restore runs as a background operation. While running, its status is visible in the **Restore History** tab:

| Status | Color | Meaning |
|--------|-------|---------|
| `running` | Blue | Restore is in progress |
| `completed` | Green | Restore finished successfully |
| `failed` | Red | Restore encountered an error |
| `pending` | Yellow | Restore is queued |

Each history row shows the start time, status, source backup URL, duration, and error message (if failed).

## What to watch out for

- **Restoring to the existing database destroys all current data.** Make a manual backup of the current database before restoring if you need to preserve it.
- The restore runs inside a Docker container using the **restore Docker image** configured in System Settings. Ensure this image is available.
- Restoring a large backup takes time. The dialog shows an estimated duration based on file size, but actual time depends on database schema complexity and index rebuilding.
- If the target database is actively being used during a restore, connections may be interrupted or data written during the restore may be lost.
