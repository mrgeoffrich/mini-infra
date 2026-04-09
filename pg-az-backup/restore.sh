#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL restore script — downloads backup from Azure via SAS URL and restores it.
# Sourced env vars from run.sh: PG_OPTS, POSTGRES_DATABASE, AZURE_SAS_URL, DROP_PUBLIC

DATA_DIR="/etc/data"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Starting restore process"
echo "Target database: ${POSTGRES_DATABASE}"

# ── Detect backup format from SAS URL path ───────────────────────────────────

# Strip query string to get the blob path, then extract the extension
BLOB_PATH="${AZURE_SAS_URL%%\?*}"

detect_format() {
    case "$BLOB_PATH" in
        *.sql.gz) echo "sql.gz" ;;
        *.sql)    echo "sql" ;;
        *.dump)   echo "custom" ;;
        *.backup) echo "custom" ;;
        *.tar.gz) echo "tar" ;;
        *.tar)    echo "tar" ;;
        *)        echo "sql" ;;  # default assumption
    esac
}

FORMAT=$(detect_format)
echo "Detected format: ${FORMAT}"

# ── Ensure database exists ───────────────────────────────────────────────────

if psql $PG_OPTS -lqt | cut -d'|' -f1 | grep -qw "$POSTGRES_DATABASE"; then
    echo "Database '${POSTGRES_DATABASE}' already exists"
else
    echo "Database '${POSTGRES_DATABASE}' does not exist, creating it..."
    psql $PG_OPTS -c "CREATE DATABASE \"${POSTGRES_DATABASE}\""
    echo "Successfully created database '${POSTGRES_DATABASE}'"
fi

# ── Download backup from Azure ───────────────────────────────────────────────

LOCAL_FILE="downloaded_backup"

log "Downloading backup from Azure Blob Storage"

HTTP_CODE=$(curl -s -o "$LOCAL_FILE" -w "%{http_code}" "$AZURE_SAS_URL")

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    FILE_SIZE=$(stat -c%s "$LOCAL_FILE" 2>/dev/null || stat -f%z "$LOCAL_FILE" 2>/dev/null || echo "unknown")
    if [ "$FILE_SIZE" != "unknown" ]; then
        FILE_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $FILE_SIZE / 1048576}")
        echo "Downloaded file size: ${FILE_SIZE_MB} MB"
    fi
    log "Download completed successfully"
else
    echo "Error: Download failed with HTTP ${HTTP_CODE}" >&2
    rm -f "$LOCAL_FILE"
    exit 1
fi

# ── Prepare restore file ────────────────────────────────────────────────────

RESTORE_FILE="$LOCAL_FILE"
RESTORE_METHOD="psql"

case "$FORMAT" in
    sql.gz)
        echo "Decompressing gzipped SQL file..."
        gzip -d -c "$LOCAL_FILE" > dump.sql
        RESTORE_FILE="dump.sql"
        RESTORE_METHOD="psql"
        ;;
    sql)
        RESTORE_METHOD="psql"
        ;;
    custom)
        RESTORE_METHOD="pg_restore"
        ;;
    tar)
        RESTORE_METHOD="pg_restore"
        ;;
esac

echo "Will use ${RESTORE_METHOD} for restoration"

# ── Handle DROP_PUBLIC option ────────────────────────────────────────────────

if [ "$DROP_PUBLIC" = "yes" ]; then
    echo "Recreating the public schema"
    psql $PG_OPTS -d "$POSTGRES_DATABASE" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
fi

if [ "$DROP_PUBLIC" = "create" ]; then
    echo "Creating the new database"
    psql $PG_OPTS -c "CREATE DATABASE \"${POSTGRES_DATABASE}\""
fi

# ── Restore database ────────────────────────────────────────────────────────

log "Starting database restoration using ${RESTORE_METHOD}"

if [ "$RESTORE_METHOD" = "psql" ]; then
    psql $PG_OPTS -d "$POSTGRES_DATABASE" < "$RESTORE_FILE"
else
    pg_restore $PG_OPTS -d "$POSTGRES_DATABASE" "$RESTORE_FILE"
fi

log "Database restoration completed"

# ── Cleanup ──────────────────────────────────────────────────────────────────

rm -f "$LOCAL_FILE" dump.sql 2>/dev/null || true
echo "Cleaned up temporary files"

log "Restore process completed successfully"
