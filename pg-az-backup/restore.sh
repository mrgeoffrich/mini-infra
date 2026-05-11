#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL restore script — downloads a backup from the active storage
# backend and restores it.
# Sourced env vars from run.sh: PG_OPTS, POSTGRES_DATABASE, STORAGE_PROVIDER,
#   DROP_PUBLIC, plus provider-specific creds.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="/etc/data"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Starting restore process"
echo "Target database: ${POSTGRES_DATABASE}"
echo "Storage provider: ${STORAGE_PROVIDER}"

# ── Detect backup format ─────────────────────────────────────────────────────
# For Azure: parse the SAS URL path. For Drive: use the file name we shipped
# in STORAGE_GDRIVE_FILE_NAME (the name preserves the format suffix).

detect_format_from_path() {
    case "$1" in
        *.sql.gz) echo "sql.gz" ;;
        *.sql)    echo "sql" ;;
        *.dump)   echo "custom" ;;
        *.backup) echo "custom" ;;
        *.tar.gz) echo "tar" ;;
        *.tar)    echo "tar" ;;
        *)        echo "sql" ;;  # default assumption
    esac
}

case "$STORAGE_PROVIDER" in
    azure)
        BLOB_PATH="${AZURE_SAS_URL%%\?*}"
        FORMAT=$(detect_format_from_path "$BLOB_PATH")
        ;;
    google-drive)
        FORMAT=$(detect_format_from_path "${STORAGE_GDRIVE_FILE_NAME:-}")
        ;;
    *)
        echo "Unknown STORAGE_PROVIDER: $STORAGE_PROVIDER" >&2
        exit 64
        ;;
esac

echo "Detected format: ${FORMAT}"

# ── Ensure database exists ───────────────────────────────────────────────────

if psql $PG_OPTS -lqt | cut -d'|' -f1 | grep -qw "$POSTGRES_DATABASE"; then
    echo "Database '${POSTGRES_DATABASE}' already exists"
else
    echo "Database '${POSTGRES_DATABASE}' does not exist, creating it..."
    psql $PG_OPTS -c "CREATE DATABASE \"${POSTGRES_DATABASE}\""
    echo "Successfully created database '${POSTGRES_DATABASE}'"
fi

# ── Download backup ─────────────────────────────────────────────────────────

LOCAL_FILE="downloaded_backup"

# JobPool-spawned containers race the egress-gateway's container-map push
# when they bring up a brand-new container — for a few seconds the egress
# gateway sees the container's source IP as "unmapped" and returns HTTP
# 403 to all CONNECTs. Backport the 6-attempt retry shape from
# `backup.sh:91-128` so a fresh-spawn restore doesn't fail on the first
# download attempt (MINI-50 review finding M7 — the framework-level
# pool-spawner ack fix is filed as MINI-63 follow-up). The retry budget
# covers the worst-case observed 5-second propagation delay; if every
# retry trips 403 it's a real egress-policy issue and the script exits
# non-zero so the JobPool exit watcher records the failure.
azure_download() {
    curl -s -o "$LOCAL_FILE" -D /tmp/download-headers.txt -w "%{http_code}" "$AZURE_SAS_URL"
}

case "$STORAGE_PROVIDER" in
    azure)
        log "Downloading backup from Azure Blob Storage"
        DOWNLOAD_ATTEMPTS=0
        HTTP_CODE=000
        while [ "$DOWNLOAD_ATTEMPTS" -lt 6 ]; do
            DOWNLOAD_ATTEMPTS=$((DOWNLOAD_ATTEMPTS + 1))
            HTTP_CODE=$(azure_download || echo 000)
            if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
                log "Download completed successfully (HTTP ${HTTP_CODE}, attempt ${DOWNLOAD_ATTEMPTS})"
                break
            fi
            if [ "$HTTP_CODE" = "403" ]; then
                # curl writes the response body into $LOCAL_FILE on a 403 — peek
                # at it to detect the egress-gateway not-mapped marker. If it
                # matches, sleep + retry. If it doesn't, fall through to the
                # generic retry (still bounded by the budget).
                BODY=$(head -c 200 "$LOCAL_FILE" 2>/dev/null || true)
                if echo "$BODY" | grep -q "is not mapped to a managed stack"; then
                    log "Download attempt ${DOWNLOAD_ATTEMPTS} hit egress-gateway IP-not-mapped race — sleeping 2s and retrying"
                    rm -f "$LOCAL_FILE"
                    sleep 2
                    continue
                fi
            fi
            log "Download attempt ${DOWNLOAD_ATTEMPTS} failed (HTTP ${HTTP_CODE})"
            rm -f "$LOCAL_FILE"
            sleep 2
        done
        if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "Error: Azure download failed after ${DOWNLOAD_ATTEMPTS} attempts (last HTTP ${HTTP_CODE})" >&2
            echo "Last response body:" >&2
            head -c 500 "$LOCAL_FILE" 2>/dev/null >&2 || true
            echo >&2
            rm -f "$LOCAL_FILE"
            exit 1
        fi
        ;;
    google-drive)
        log "Downloading backup from Google Drive"
        if ! node "$SCRIPT_DIR/download-google-drive.mjs" "$LOCAL_FILE"; then
            echo "Error: Google Drive download failed" >&2
            rm -f "$LOCAL_FILE"
            exit 1
        fi
        log "Download completed successfully"
        ;;
    *)
        echo "Unknown STORAGE_PROVIDER: $STORAGE_PROVIDER" >&2
        exit 64
        ;;
esac

FILE_SIZE=$(stat -c%s "$LOCAL_FILE" 2>/dev/null || stat -f%z "$LOCAL_FILE" 2>/dev/null || echo "unknown")
if [ "$FILE_SIZE" != "unknown" ]; then
    FILE_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $FILE_SIZE / 1048576}")
    echo "Downloaded file size: ${FILE_SIZE_MB} MB"
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
