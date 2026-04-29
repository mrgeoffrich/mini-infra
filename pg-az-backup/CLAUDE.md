# PostgreSQL Azure Backup

One-shot container that backs up a PostgreSQL database to Azure Blob Storage (or restores from one), using a pre-signed SAS URL for upload/download. The server schedules this container via the stack engine — it runs, streams pg_dump → curl, and exits.

## Structure

```
pg-az-backup/
├── Dockerfile        # Alpine + bash + curl + postgresql-client + gzip
├── run.sh            # Entry point: validates env, dispatches to backup or restore
├── backup.sh         # pg_dump → gzip → curl PUT to AZURE_SAS_URL
├── restore.sh        # curl GET → gunzip → pg_restore (or psql for plain)
└── envvars.txt       # Documented env contract (kept in sync with run.sh)
```

## Required Environment

| Variable | Purpose |
|----------|---------|
| `POSTGRES_HOST` | DB host |
| `POSTGRES_PORT` | Defaults to `5432` |
| `POSTGRES_USER` | DB user |
| `POSTGRES_PASSWORD` | DB password (exported as `PGPASSWORD`) |
| `POSTGRES_DATABASE` | Target database |
| `AZURE_SAS_URL` | Pre-signed Azure Blob URL (write for backup, read for restore) |

## Optional Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `RESTORE` | `no` | Set to `yes` to restore instead of backup |
| `DROP_PUBLIC` | `no` | Set to `yes` to drop+recreate `public` schema before restore |
| `BACKUP_FORMAT` | `plain` | `plain`, `custom`, `directory`, or `tar` |
| `COMPRESSION_LEVEL` | `6` | `0`–`9` |

## Build

The image is built as part of the main Mini Infra image build pipeline. To build standalone:

```bash
docker build -t mini-infra-pg-az-backup pg-az-backup/
```

## Conventions

- **Stay small.** This is a leaf container — no node, no python, no agent. Just bash + curl + pg client.
- **SAS URLs only.** No Azure SDK; we trust the server to mint a short-lived SAS URL with the right scope. Don't add account-key auth here.
- **Exit codes matter.** The server interprets non-zero exit as failure and surfaces it on the backup record. Don't swallow errors in the shell scripts.
- **Streaming pipeline.** `pg_dump | gzip | curl --upload-file -` keeps memory bounded for large DBs. Don't introduce intermediate files unless absolutely necessary.
