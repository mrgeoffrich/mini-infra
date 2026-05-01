# PostgreSQL Backup Sidecar (`pg-az-backup`)

One-shot container that backs up a PostgreSQL database to whichever Storage
backend is active (Azure Blob via SAS URL, or Google Drive via OAuth token),
or restores from one. The server schedules this container via the stack
engine — it runs, streams `pg_dump` → upload, and exits.

## Structure

```
pg-az-backup/
├── Dockerfile                  # Alpine + bash + curl + postgresql-client + gzip + node + googleapis
├── package.json                # googleapis dep used by the .mjs upload/download scripts
├── run.sh                      # Entry point: validates env, dispatches to backup or restore
├── backup.sh                   # pg_dump → gzip → branch on STORAGE_PROVIDER → upload
├── restore.sh                  # branch on STORAGE_PROVIDER → download → pg_restore (or psql)
├── upload-google-drive.mjs     # Drive v3 resumable upload from a file path
├── download-google-drive.mjs   # Stream Drive file content to stdout / a path
└── envvars.txt                 # Documented env contract (kept in sync with run.sh)
```

## Required Environment

| Variable | Purpose |
|----------|---------|
| `POSTGRES_HOST` | DB host |
| `POSTGRES_PORT` | Defaults to `5432` |
| `POSTGRES_USER` | DB user |
| `POSTGRES_PASSWORD` | DB password (exported as `PGPASSWORD`) |
| `POSTGRES_DATABASE` | Target database |
| `STORAGE_PROVIDER` | `azure` (default) or `google-drive` |

### Azure-specific

| Variable | Purpose |
|----------|---------|
| `AZURE_SAS_URL` | Pre-signed Azure Blob URL (write for backup, read for restore) |

### Google Drive-specific (backup)

| Variable | Purpose |
|----------|---------|
| `STORAGE_GDRIVE_ACCESS_TOKEN` | Short-lived OAuth access token (server mints via `mintUploadHandle`) |
| `STORAGE_GDRIVE_FOLDER_ID` | Destination Drive folder id |
| `STORAGE_GDRIVE_FILE_NAME` | Filename to write within the folder |
| `STORAGE_GDRIVE_TOKEN_EXPIRES_AT` | ISO timestamp; informational |

### Google Drive-specific (restore)

| Variable | Purpose |
|----------|---------|
| `STORAGE_GDRIVE_ACCESS_TOKEN` | Short-lived OAuth access token |
| `STORAGE_GDRIVE_FILE_ID` | Source file id (server resolves via `head()`) |
| `STORAGE_GDRIVE_FILE_NAME` | Informational; preserves backup format suffix for detection |

## Optional Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `RESTORE` | `no` | Set to `yes` to restore instead of backup |
| `DROP_PUBLIC` | `no` | Set to `yes` to drop+recreate `public` schema before restore |
| `BACKUP_FORMAT` | `plain` | `plain`, `custom`, `directory`, or `tar` |
| `COMPRESSION_LEVEL` | `6` | `0`–`9` |

## Build

The image is built as part of the main Mini Infra image build pipeline. To
build standalone:

```bash
docker build -t mini-infra-pg-az-backup pg-az-backup/
```

## Conventions

- **Stay small.** This is a leaf container. We do bring in node + googleapis
  for the Drive path, but no agent / no python / no extra services.
- **Server mints credentials, container uploads.** Both providers follow the
  same pattern — the server hands the container a short-lived credential
  bundle, the container uploads directly. No long-lived secrets in the
  container's env.
- **Exit codes matter.** The server interprets non-zero exit as failure and
  surfaces it on the backup record. Don't swallow errors in the shell scripts.
- **Streaming pipeline.** `pg_dump | gzip` keeps memory bounded for large DBs.
  The uploader scripts stream from disk to the cloud rather than buffering.
