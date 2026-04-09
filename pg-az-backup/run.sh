#!/usr/bin/env bash
set -euo pipefail

# pg-az-backup: PostgreSQL backup/restore with Azure Blob Storage via SAS URLs
#
# Required env vars:
#   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE
#   AZURE_SAS_URL  — pre-signed Azure Blob Storage URL (write for backup, read for restore)
#
# Optional env vars:
#   RESTORE=yes          — run restore instead of backup
#   DROP_PUBLIC=yes      — drop and recreate public schema before restore
#   BACKUP_FORMAT=plain  — plain, custom, directory, or tar
#   COMPRESSION_LEVEL=6  — 0-9

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Validate required variables ──────────────────────────────────────────────

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DATABASE:?POSTGRES_DATABASE is required}"
: "${AZURE_SAS_URL:?AZURE_SAS_URL is required}"

export PGPASSWORD="$POSTGRES_PASSWORD"

RESTORE="${RESTORE:-no}"
DROP_PUBLIC="${DROP_PUBLIC:-no}"
BACKUP_FORMAT="${BACKUP_FORMAT:-plain}"
COMPRESSION_LEVEL="${COMPRESSION_LEVEL:-6}"

# Common pg connection options
PG_OPTS="-h ${POSTGRES_HOST} -p ${POSTGRES_PORT} -U ${POSTGRES_USER}"

# ── Dispatch ─────────────────────────────────────────────────────────────────

if [ "$RESTORE" = "yes" ]; then
    exec "$SCRIPT_DIR/restore.sh"
else
    exec "$SCRIPT_DIR/backup.sh"
fi
