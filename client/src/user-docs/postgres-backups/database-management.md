---
title: Managing PostgreSQL Databases
description: How to add, edit, and manage PostgreSQL database connections in Mini Infra.
tags:
  - postgres
  - configuration
  - backup
---

# Managing PostgreSQL Databases

Mini Infra manages PostgreSQL connections as "database configurations". Each configuration stores connection details for one database on a PostgreSQL server. You can manage these from [/postgres-server](/postgres-server) or [/postgres-backup](/postgres-backup).

## Adding a database

Click **Add Database** on the PostgreSQL page to open a three-step wizard.

### Step 1 — Connection Details

Enter the server connection details:

| Field | Description |
|-------|-------------|
| **Host** | Hostname or IP address of the PostgreSQL server |
| **Port** | PostgreSQL port (default: `5432`) |
| **Username** | PostgreSQL user with access to the target database |
| **SSL Mode** | Connection security: `Require`, `Prefer`, or `Disable` |
| **Password** | Password for the user |

Click **Connect & Discover** to test the connection and retrieve the list of available databases.

### Step 2 — Select Database

Choose the database you want to manage from the list of databases discovered on the server. Each entry shows the database name, encoding, and collation. Click a database card to select it.

### Step 3 — Final Details

Review and finalize the configuration:

| Field | Description |
|-------|-------------|
| **Configuration Name** | A friendly name for this connection (e.g., `my-app-db`) |
| **SSL Mode** | SSL connection mode |
| **Host**, **Port**, **Database**, **Username**, **Password** | Pre-filled from step 1 and 2; can be adjusted |

Click **Test Connection** to verify the final configuration, then **Create** to save.

## Editing a database connection

Click the **Pencil** icon on a database row to open the edit dialog. All fields except the database name are editable. Leave the password field blank to keep the existing password.

## Deleting a database connection

Click the **Trash** icon on a database row. A confirmation dialog appears. Deleting a connection does **not** delete the actual PostgreSQL database — it only removes the Mini Infra configuration entry.

## PostgreSQL Server detail page

Go to `/postgres-server/:serverId` to view a server's detail page. From there, navigate to individual databases at `/postgres-server/:serverId/databases/:dbId` for database-level details.

## PostgreSQL containers

If you have PostgreSQL containers visible on the **Containers** page, you can link them to Mini Infra's postgres management:

1. Go to [/containers](/containers).
2. Find a PostgreSQL container and click **Add** in the Actions column.
3. Complete the connection form (host, port, user, password) — Mini Infra pre-fills values from the container's environment variables if available.

A linked container shows a **Manage** button that navigates to its server detail page.

## SSL mode options

| Mode | Description |
|------|-------------|
| `Require` | Only connect if SSL is available; fail otherwise |
| `Prefer` | Use SSL if available, fall back to plaintext |
| `Disable` | Never use SSL |

## What to watch out for

- **Credentials are stored encrypted** in the Mini Infra database. However, treat them with care — any user with API access can retrieve connection details.
- The **Test Connection** step in the wizard validates credentials and network connectivity. A successful test does not guarantee that the backup user has the necessary permissions for `pg_dump`.
- Deleting a database configuration removes all associated backup history and configuration from Mini Infra. The Azure backup files themselves are not deleted.
