---
title: Configuring Backups
description: How to connect a PostgreSQL database and set up automated backup schedules.
category: PostgreSQL Backups
order: 2
tags:
  - postgres
  - backups
  - configuration
  - scheduling
  - cron
  - azure
---

# Configuring Backups

Setting up backups is a two-step process: first you register a database connection, then you configure a backup schedule for it.

## Adding a database connection

Click **Add Database** on the PostgreSQL Backups page. A three-step wizard walks you through the setup:

### Step 1: Connection details

Enter the PostgreSQL server connection information:

- **Host** — The hostname or IP address of the PostgreSQL server.
- **Port** — Defaults to 5432.
- **Username** and **Password** — Credentials for a user with read access to the databases you want to back up.
- **SSL Mode** — Choose Require, Prefer, or Disable depending on your server's TLS configuration.

Click **Connect & Discover** to test the connection. If it succeeds, Mini Infra queries the server for all available databases.

### Step 2: Database selection

A list of discovered databases appears, showing each database's name, size, encoding, and collation. Select the one you want to back up.

### Step 3: Final details

Review and adjust the configuration:

- **Configuration Name** — A display name for this database in Mini Infra. Defaults to the database name.
- Connection fields are pre-filled from the previous steps but can be edited.
- Click **Test Connection** to verify everything works, then click **Create**.

## Editing a database connection

Click the edit button on any database row to update its connection details. The form is the same as the creation wizard but in a single step. Leave the password field empty to keep the existing password.

## Setting up a backup schedule

Click the backup configuration button (gear icon) on a database row. The backup configuration dialog opens with these options:

### Schedule

- **Enable automated backups** — Toggle to activate or deactivate the schedule. Disabling keeps the configuration but stops running backups.
- **Cron expression** — Defines when backups run. Standard five-field cron format.
- **Timezone** — The timezone for interpreting the cron schedule. A searchable dropdown shows all IANA timezones with the current time in the selected zone.

Common schedule examples:

| Expression | Meaning |
|-----------|---------|
| `0 2 * * *` | Daily at 2:00 AM |
| `0 2 * * 0` | Weekly on Sunday at 2:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `0 2 * * 1-5` | Weekdays at 2:00 AM |

### Azure storage

- **Container** — Which Azure Blob Storage container to store backups in. The dropdown loads available containers from your Azure connection.
- **Path Prefix** — An optional folder path within the container. Useful for organising backups by database or environment.

### Backup settings

- **Retention Days** — How many days to keep backups before automatic cleanup. Default is 30, range is 1–365.
- **Backup Format** — The pg_dump output format: Custom (compressed, supports parallel restore), Plain (SQL text), or TAR.
- **Compression Level** — 0 (no compression) to 9 (maximum). Default is 6. Higher values produce smaller files but take longer.

Click **Save** to create or update the configuration. If the schedule is enabled, the next backup time appears in the database table.

## Running a manual backup

You don't have to wait for the schedule. Click the play button on any database row to trigger a backup immediately. The operation appears in the **Active Operations** tab at the bottom of the page with a live progress bar.

## Deleting a backup configuration

Open the backup configuration dialog and click the red **Delete Configuration** button at the bottom left. This removes the schedule and configuration but does not delete existing backups from Azure.

## What to watch out for

- The cron timezone matters. A schedule of `0 2 * * *` in UTC runs at a different time than the same expression in `America/New_York`. The dialog shows the next scheduled time so you can verify.
- Retention is enforced per backup configuration. Changing retention from 30 to 7 days doesn't immediately delete older backups — they're cleaned up on the next scheduled cleanup run.
- Only one backup configuration is allowed per database. To change the schedule, edit the existing configuration rather than creating a new one.
- The Azure container must be accessible with the connection string configured in Connected Services. If you see errors about container access, verify the Azure configuration first.
