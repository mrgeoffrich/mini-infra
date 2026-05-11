#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL backup script — dumps the database and uploads to the active
# storage backend.
# Sourced env vars from run.sh: PG_OPTS, POSTGRES_DATABASE, STORAGE_PROVIDER,
#   BACKUP_FORMAT, COMPRESSION_LEVEL, plus provider-specific creds.
#
# Phase 4 (MINI-53): in-container NATS progress publishing. The runtime env
# resolver injects NATS_URL / NATS_CREDS / JOB_RUN_ID; this script invokes
# `nats-progress.sh` at the same milestones the legacy server-mediated bridge
# used to derive from stdout. Missing NATS env is tolerated — backups still
# run, the UI just doesn't see live progress.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="/etc/data"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
# Best-effort progress publisher — never aborts the backup on failure.
publish_progress() {
    "$SCRIPT_DIR/nats-progress.sh" "$1" "$2" "${3:-}" || true
}

publish_progress running 10 "Preparing backup operation"

log "Starting backup process"
echo "Database: ${POSTGRES_DATABASE}"
echo "Host: ${POSTGRES_HOST}"
echo "Backup format: ${BACKUP_FORMAT}"
echo "Compression level: ${COMPRESSION_LEVEL}"
echo "Storage provider: ${STORAGE_PROVIDER}"

# ── Create dump ──────────────────────────────────────────────────────────────

publish_progress running 25 "Creating database dump"
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

publish_progress running 60 "Uploading backup to storage"
# Phase 4 (MINI-53): JobPool-spawned containers race the egress-gateway's
# container-map push when they bring up a brand-new container — for a few
# seconds the egress gateway sees the container's source IP as "unmapped"
# and returns HTTP 403 to all CONNECTs. Retry the upload a handful of times
# with a short backoff so the map sync catches up. The retry budget covers
# the worst-case observed 5-second propagation delay. If every retry trips
# 403 it's a real egress-policy issue (missing host in `requiredEgress`)
# and surfaces as an exit non-zero so the JobPool exit watcher records the
# failure.
azure_upload() {
    curl -s -o /tmp/upload-resp.txt -w "%{http_code}" \
        -X PUT \
        -H "x-ms-blob-type: BlockBlob" \
        -H "Content-Type: application/octet-stream" \
        -T "$FINAL_FILE" \
        "$AZURE_SAS_URL"
}
case "$STORAGE_PROVIDER" in
    azure)
        log "Uploading to Azure Blob Storage via SAS URL"
        UPLOAD_ATTEMPTS=0
        HTTP_CODE=000
        while [ "$UPLOAD_ATTEMPTS" -lt 6 ]; do
            UPLOAD_ATTEMPTS=$((UPLOAD_ATTEMPTS + 1))
            HTTP_CODE=$(azure_upload || echo 000)
            if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
                log "Upload completed successfully (HTTP ${HTTP_CODE}, attempt ${UPLOAD_ATTEMPTS})"
                break
            fi
            if [ "$HTTP_CODE" = "403" ]; then
                BODY=$(cat /tmp/upload-resp.txt 2>/dev/null | head -c 200 || true)
                if echo "$BODY" | grep -q "is not mapped to a managed stack"; then
                    log "Upload attempt ${UPLOAD_ATTEMPTS} hit egress-gateway IP-not-mapped race — sleeping 2s and retrying"
                    sleep 2
                    continue
                fi
            fi
            log "Upload attempt ${UPLOAD_ATTEMPTS} failed (HTTP ${HTTP_CODE})"
            sleep 2
        done
        if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
            echo "Error: Azure upload failed after ${UPLOAD_ATTEMPTS} attempts (last HTTP ${HTTP_CODE})" >&2
            echo "Last response body:" >&2
            cat /tmp/upload-resp.txt 2>/dev/null | head -c 500 >&2 || true
            echo >&2
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

publish_progress running 95 "Backup process complete"
log "Backup process completed successfully"
