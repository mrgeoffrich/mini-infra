---
title: Restoring Backups
description: How to browse available backups and restore them to an existing or new database.
category: PostgreSQL Backups
order: 3
tags:
  - postgres
  - backups
  - restore
  - azure
  - recovery
---

# Restoring Backups

Mini Infra can restore any backup stored in Azure Blob Storage back to the original database or to a new database on the same server.

## Opening the restore page

Click the download button on a database row in the PostgreSQL Backups page. This opens the restore page for that database, which has two tabs: **Browse Backups** and **Restore History**.

## Browsing available backups

The **Browse Backups** tab lists all backup files in Azure for the selected database. Each entry shows:

- **Backup Name** — The filename in Azure storage.
- **Created** — When the backup was made.
- **Size** — The file size.

Click **Refresh** to reload the list from Azure. Backups appear in reverse chronological order (newest first).

## Starting a restore

Click **Restore** on any backup in the list. A confirmation dialog opens showing:

- The backup file name, creation date, size, and age.
- An estimated restore time based on the file size.

You then choose a restore destination:

### Overwrite the existing database

Select **Overwrite [database name]** to replace all data in the original database with the backup contents. This is destructive — the current data in the target database is replaced entirely.

### Restore to a new database

Select **Restore to new database** and enter a name for the new database. Mini Infra creates the database on the same PostgreSQL server and loads the backup into it. The original database is untouched.

Click **Restore** (or **Create & Restore** for new databases) to start the operation.

## Monitoring a restore

After confirming, the restore operation begins. You can track progress in two places:

- **Active Operations tab** on the main PostgreSQL Backups page — shows the running restore with a progress bar, current step, and time estimate.
- **Restore History tab** on the restore page — shows all past and current restore operations for the database.

Restore operations run one at a time. If you trigger a second restore while one is already running, it queues behind the first.

## Restore history

The **Restore History** tab shows every restore operation for the database with:

| Column | What it shows |
|--------|--------------|
| **Started** | When the restore began |
| **Status** | Completed, Failed, Running, or Pending |
| **Backup URL** | Which backup file was used |
| **Duration** | How long the restore took |
| **Error** | Error message if the restore failed |

## What to watch out for

- Restoring to the existing database is destructive. All current data is replaced. There is no undo — if you need the current data, back it up first.
- The restore Docker image must be compatible with the PostgreSQL version of the backup. A backup made with PostgreSQL 16 may not restore into a PostgreSQL 12 server.
- Restore operations have a 2-hour timeout. Very large databases may need the timeout adjusted or may need to be restored outside Mini Infra.
- Only one restore runs at a time (concurrency of 1). Additional restore requests are queued.
- Restoring to a new database requires that the PostgreSQL user configured in Mini Infra has permission to create databases on the server.
