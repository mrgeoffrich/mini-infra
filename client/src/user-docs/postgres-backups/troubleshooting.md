---
title: Backup Troubleshooting
description: Common backup and restore issues and how to diagnose them.
category: PostgreSQL Backups
order: 4
tags:
  - postgres
  - backups
  - restore
  - troubleshooting
  - errors
  - azure
---

# Backup Troubleshooting

Common issues with PostgreSQL backups and restores in Mini Infra and how to investigate them.

---

## Backup fails immediately

**Symptom:** A manual or scheduled backup starts but fails within seconds.

**Likely cause:** The Docker images for pg_dump aren't configured, or the configured image can't be pulled.

**What to check:**

- Go to **System Settings** under Administration. Verify that the backup Docker image is set to a valid PostgreSQL image (e.g. `postgres:16`).
- Check the Docker connectivity indicator in the header. If it's red, Mini Infra can't reach the Docker daemon.
- Look at the error message in the Active Operations tab or History tab — it usually says what went wrong.

**Fix:** Set a valid PostgreSQL Docker image in System Settings. Make sure the image is available on the host (or can be pulled from a configured registry).

---

## Backup stuck or taking too long

**Symptom:** The progress bar sits at a low percentage for an extended period, or the backup has been running for over an hour.

**Likely cause:** The database is very large, or there's a network bottleneck between the backup container and the PostgreSQL server or Azure storage.

**What to check:**

- Check the Active Operations tab for the current progress percentage and step.
- For large databases, backups can legitimately take a long time. The 2-hour timeout is the hard limit.
- Check whether the PostgreSQL server is under heavy load, which can slow down pg_dump.

**Fix:** For very large databases, consider running backups during off-peak hours. If the backup consistently times out, you may need to run pg_dump manually outside Mini Infra.

---

## Azure connection errors

**Symptom:** Backup completes the dump step but fails during upload, with an error mentioning Azure or blob storage.

**Likely cause:** The Azure Storage connection string is invalid, expired, or the target container doesn't exist.

**What to check:**

- Go to the **Azure** page under Connected Services and verify the connection status is green.
- Check that the Azure container specified in the backup configuration exists. Open the Azure page to see available containers.
- Verify the connection string hasn't been rotated in the Azure portal without updating it in Mini Infra.

**Fix:** Update the Azure connection string on the Azure connectivity page, then retry the backup.

---

## Credential errors

**Symptom:** Backup fails with authentication or permission errors.

**Likely cause:** The PostgreSQL username or password stored in Mini Infra is wrong, or the user doesn't have sufficient permissions.

**What to check:**

- Edit the database connection and click **Test Connection** to verify credentials still work.
- The PostgreSQL user needs at least `SELECT` permission on all tables and `USAGE` on schemas to run pg_dump.

**Fix:** Update the credentials on the database connection, or grant the necessary permissions on the PostgreSQL server.

---

## Restore fails with version mismatch

**Symptom:** Restore fails with an error about incompatible archive versions or unsupported features.

**Likely cause:** The restore Docker image is a different PostgreSQL major version than the one used to create the backup.

**What to check:**

- Note the PostgreSQL version of the server that created the backup.
- Check the restore Docker image configured in **System Settings**.

**Fix:** Set the restore Docker image to match the PostgreSQL version of the backup. For example, if backups were made with PostgreSQL 16, use `postgres:16` as the restore image.

---

## Restore to new database fails with permission error

**Symptom:** Choosing "Restore to new database" fails with a permission denied or CREATE DATABASE error.

**Likely cause:** The PostgreSQL user configured in Mini Infra doesn't have permission to create databases on the server.

**What to check:**

- Connect to the PostgreSQL server directly and check the user's role: `SELECT rolcreatedb FROM pg_roles WHERE rolname = 'your_user';`

**Fix:** Grant the CREATEDB privilege: `ALTER ROLE your_user CREATEDB;` Or restore to an existing database instead.

---

## Health status shows Unhealthy

**Symptom:** A database connection shows a red "Unhealthy" badge in the table.

**Likely cause:** Mini Infra can't connect to the PostgreSQL server with the stored credentials.

**What to check:**

- Click edit on the database and use **Test Connection** to see the specific error.
- Verify the PostgreSQL server is running and accessible from the Docker host.
- Check if the server's `pg_hba.conf` allows connections from the Mini Infra host.
- If using SSL mode "Require", confirm the server supports TLS connections.

**Fix:** Address the connection issue identified by the test. Common fixes include restarting the PostgreSQL server, updating credentials, or adjusting firewall rules.

---

## Scheduled backups not running

**Symptom:** The backup schedule is configured and enabled, but no backups appear in the history at the expected times.

**Likely cause:** The cron expression or timezone may be misconfigured, or the Mini Infra server was restarted and the scheduler hasn't picked up the configuration.

**What to check:**

- Open the backup configuration and verify the cron expression and timezone are correct. The dialog shows when the next backup is scheduled.
- Check the **History** tab to see if backups ran at unexpected times (timezone confusion).
- Look at the Mini Infra server logs for scheduler errors.

**Fix:** Correct the cron expression or timezone. If the scheduler seems stuck, restarting the Mini Infra server forces it to reload all backup configurations.
