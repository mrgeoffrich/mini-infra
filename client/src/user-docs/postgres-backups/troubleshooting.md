---
title: PostgreSQL Backup Troubleshooting
description: Common PostgreSQL backup and restore issues and how to resolve them.
tags:
  - postgres
  - backup
  - restore
  - troubleshooting
  - azure
---

# PostgreSQL Backup Troubleshooting

---

## Backup fails with "PostgreSQL containers not configured"

**Symptom:** An alert on the PostgreSQL pages says "PostgreSQL containers not configured: Backup and restore operations require Docker images to be configured in system settings."

**Likely cause:** The backup and/or restore Docker image has not been set in System Settings.

**What to check:** Go to [Settings → System Settings](/settings-system) and look for the **Backup Container Settings** and **Restore Container Settings** sections.

**Fix:** Enter a valid PostgreSQL Docker image (e.g., `postgres:15-alpine`) in both fields and save.

---

## Database shows "Unhealthy" status

**Symptom:** A database connection shows the `Unhealthy` health badge.

**Likely cause:** Mini Infra cannot connect to the PostgreSQL server. Possible causes: wrong host/port, wrong credentials, network connectivity issues, or SSL mode mismatch.

**What to check:** Click the pencil icon to open the edit dialog, review the connection details, and click **Test Connection**.

**Fix:** Correct the host, port, username, password, or SSL mode. Ensure the PostgreSQL server is running and accessible from the Mini Infra host.

---

## Backup fails with Azure authentication error

**Symptom:** A backup operation fails and the error mentions Azure authentication, access denied, or missing container.

**Likely cause:** The Azure Storage connection is not configured, the connection string is invalid, or the configured Azure container does not exist.

**What to check:** Go to [Connected Services → Azure Storage](/connectivity-storage) and verify the connection is healthy. Also check the backup configuration to ensure a valid Azure container is selected.

**Fix:** Re-enter and validate the Azure connection string. Ensure the selected container exists in Azure. Create the container in Azure Portal if needed.

---

## No backups appear in the Browse Backups tab

**Symptom:** The restore page shows "No backups found" even though backups appear to have run successfully.

**Likely cause:** The **Path Prefix** in the backup configuration does not match where the files were stored, or the Azure container was changed.

**What to check:** In the backup configuration, check the **Container** and **Path Prefix** values. The path prefix is the folder within the container where backup files are stored.

**Fix:** Verify that the path prefix matches the prefix used when the backups were created. If you changed the container or prefix, use the Azure portal to browse for the files.

---

## Restore fails with "database is being accessed by other users"

**Symptom:** A restore operation fails with a message about active database connections.

**Likely cause:** Other applications or users are connected to the database while the restore is running.

**What to check:** Review the error in the Restore History tab.

**Fix:** Stop all connections to the target database before restoring. If this is a production database, plan the restore during a maintenance window or restore to a new database instead of overwriting.

---

## Backup history shows "in_progress" but backup appears stuck

**Symptom:** A backup operation has shown `In Progress` status for an unusually long time.

**Likely cause:** The backup Docker container may have exited unexpectedly, or there is a network issue communicating with Azure.

**What to check:** Check the Docker containers list for any backup-related containers. Check the Mini Infra application logs for errors.

**Fix:** If the container is no longer running but the status is still `in_progress`, the operation may have been interrupted. Trigger a new manual backup to verify functionality.

---
