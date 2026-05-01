#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL backup script — dumps the database and uploads to the active
# storage backend.
# Sourced env vars from run.sh: PG_OPTS, POSTGRES_DATABASE, STORAGE_PROVIDER,
#   BACKUP_FORMAT, COMPRESSION_LEVEL, plus provider-specific creds.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="/etc/data"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Starting backup process"
echo "Database: ${POSTGRES_DATABASE}"
echo "Host: ${POSTGRES_HOST}"
echo "Backup format: ${BACKUP_FORMAT}"
echo "Compression level: ${COMPRESSION_LEVEL}"
echo "Storage provider: ${STORAGE_PROVIDER}"

# ── Create dump ──────────────────────────────────────────────────────────────

BACKUP_FORMAT="$(echo "$BACKUP_FORMAT" | tr '[:upper:]' '[:lower:]')"

case "$BACKUP_FORMAT" in
    custom)
        DUMP_FILE="backup.dump"
        FINAL_FILE="backup.dump"
        log "Creating custom format dump"
        pg_dump $PG_OPTS --format=custom "--compress=${COMPRESSION_LEVEL}" --file="$DUMP_FILE" "$POSTGRES_DATABASE"
        ;;
    directory)
        DUMP_FILE="dump_dir"
        FINAL_FILE="dump.tar.gz"
        log "Creating directory format dump"
        pg_dump $PG_OPTS --format=directory "--compress=${COMPRESSION_LEVEL}" --file="$DUMP_FILE" "$POSTGRES_DATABASE"
        log "Creating tar archive: ${FINAL_FILE}"
        tar -czf "$FINAL_FILE" -C . "$DUMP_FILE"
        ;;
    tar)
        DUMP_FILE="dump.tar"
        FINAL_FILE="dump.tar"
        log "Creating tar format dump"
        pg_dump $PG_OPTS --format=tar "--compress=${COMPRESSION_LEVEL}" "$POSTGRES_DATABASE" > "$FINAL_FILE"
        ;;
    *)
        # Plain SQL — pipe through gzip
        DUMP_FILE="dump.sql.gz"
        FINAL_FILE="dump.sql.gz"
        log "Creating plain SQL dump (gzip compressed)"
        pg_dump $PG_OPTS "$POSTGRES_DATABASE" | gzip "-${COMPRESSION_LEVEL}" > "$FINAL_FILE"
        ;;
esac

log "pg_dump completed"

# Report file size
FILE_SIZE=$(stat -c%s "$FINAL_FILE" 2>/dev/null || stat -f%z "$FINAL_FILE" 2>/dev/null || echo "unknown")
if [ "$FILE_SIZE" != "unknown" ]; then
    FILE_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $FILE_SIZE / 1048576}")
    echo "Backup file size: ${FILE_SIZE_MB} MB"
fi

# ── Upload via the active provider ──────────────────────────────────────────

case "$STORAGE_PROVIDER" in
    azure)
        log "Uploading to Azure Blob Storage via SAS URL"
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
            -X PUT \
            -H "x-ms-blob-type: BlockBlob" \
            -H "Content-Type: application/octet-stream" \
            -T "$FINAL_FILE" \
            "$AZURE_SAS_URL")
        if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            log "Upload completed successfully (HTTP ${HTTP_CODE})"
        else
            echo "Error: Azure upload failed with HTTP ${HTTP_CODE}" >&2
            exit 1
        fi
        ;;
    google-drive)
        log "Uploading to Google Drive (resumable upload)"
        if ! node "$SCRIPT_DIR/upload-google-drive.mjs" "$FINAL_FILE"; then
            echo "Error: Google Drive upload failed" >&2
            exit 1
        fi
        log "Upload completed successfully"
        ;;
    *)
        echo "Unknown STORAGE_PROVIDER: $STORAGE_PROVIDER" >&2
        exit 64
        ;;
esac

# ── Cleanup ──────────────────────────────────────────────────────────────────

rm -rf "$DUMP_FILE" "$FINAL_FILE" 2>/dev/null || true

log "Backup process completed successfully"
