#!/usr/bin/env bash
set -euo pipefail

# pg-az-backup: PostgreSQL backup/restore with a pluggable storage backend.
#
# Required env vars (always):
#   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE
#   STORAGE_PROVIDER  azure | google-drive    (default: azure)
#
# Provider-specific env (azure):
#   AZURE_SAS_URL  pre-signed Azure Blob Storage URL (write for backup, read for restore)
#
# Provider-specific env (google-drive, backup):
#   STORAGE_GDRIVE_ACCESS_TOKEN
#   STORAGE_GDRIVE_FOLDER_ID
#   STORAGE_GDRIVE_FILE_NAME
#   STORAGE_GDRIVE_TOKEN_EXPIRES_AT     ISO timestamp; informational
#
# Provider-specific env (google-drive, restore):
#   STORAGE_GDRIVE_ACCESS_TOKEN
#   STORAGE_GDRIVE_FILE_ID
#   STORAGE_GDRIVE_FILE_NAME            informational
#
# Optional env vars:
#   RESTORE=yes          run restore instead of backup
#   DROP_PUBLIC=yes      drop and recreate public schema before restore
#   BACKUP_FORMAT=plain  plain, custom, directory, or tar
#   COMPRESSION_LEVEL=6  0-9

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Validate required variables ──────────────────────────────────────────────

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DATABASE:?POSTGRES_DATABASE is required}"

export STORAGE_PROVIDER="${STORAGE_PROVIDER:-azure}"
export RESTORE="${RESTORE:-no}"
export DROP_PUBLIC="${DROP_PUBLIC:-no}"
export BACKUP_FORMAT="${BACKUP_FORMAT:-plain}"
export COMPRESSION_LEVEL="${COMPRESSION_LEVEL:-6}"

case "$STORAGE_PROVIDER" in
    azure)
        : "${AZURE_SAS_URL:?AZURE_SAS_URL is required when STORAGE_PROVIDER=azure}"
        ;;
    google-drive)
        : "${STORAGE_GDRIVE_ACCESS_TOKEN:?STORAGE_GDRIVE_ACCESS_TOKEN is required when STORAGE_PROVIDER=google-drive}"
        if [ "$RESTORE" = "yes" ]; then
            : "${STORAGE_GDRIVE_FILE_ID:?STORAGE_GDRIVE_FILE_ID is required for google-drive restore}"
        else
            : "${STORAGE_GDRIVE_FOLDER_ID:?STORAGE_GDRIVE_FOLDER_ID is required for google-drive backup}"
            : "${STORAGE_GDRIVE_FILE_NAME:?STORAGE_GDRIVE_FILE_NAME is required for google-drive backup}"
        fi
        ;;
    *)
        echo "Unknown STORAGE_PROVIDER: $STORAGE_PROVIDER (expected azure | google-drive)" >&2
        exit 64
        ;;
esac

export PGPASSWORD="$POSTGRES_PASSWORD"

# Common pg connection options
export PG_OPTS="-h ${POSTGRES_HOST} -p ${POSTGRES_PORT} -U ${POSTGRES_USER}"

# ── Dispatch ─────────────────────────────────────────────────────────────────

if [ "$RESTORE" = "yes" ]; then
    exec "$SCRIPT_DIR/restore.sh"
else
    exec "$SCRIPT_DIR/backup.sh"
fi
