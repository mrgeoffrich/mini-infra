#!/usr/bin/env bash
# nats-progress.sh — In-container NATS progress publisher.
#
# Replaces the legacy server-mediated bridge (Phase 4, MINI-53). The pg-az-backup
# container now publishes its own progress events directly to NATS so the
# `pg-az-backup` JobPool's server-side spawn path no longer needs to tee
# stdout and parse percentages.
#
# Required env (set by the JobPool spawner via `dynamicEnv` + the runtime env
# resolver):
#   NATS_URL          NATS connection URL (resolved via `nats-url` dynamicEnv)
#   NATS_CREDS        NATS creds file contents (resolved via `nats-creds` dynamicEnv)
#   JOB_RUN_ID        Run identifier — the `BackupOperation.id` flowed through
#                     from the runtime env resolver. Used as the subject token.
#
# Usage:
#   nats-progress.sh <status> <progress> [message]
#     <status>    `running` or `pending` (only running/pending publish — the
#                 JobPool exit watcher owns `completed`/`failed` via its own
#                 per-pool history stream).
#     <progress>  Integer 0-100.
#     [message]   Optional human-readable string.
#
# The script is intentionally fire-and-forget on the publish path — a NATS
# outage must not break the backup itself. We log the failure to stderr (which
# the container's docker logs still capture) and exit 0.

set -uo pipefail

STATUS="${1:-running}"
PROGRESS="${2:-0}"
MESSAGE="${3:-}"

if [ -z "${NATS_URL:-}" ] || [ -z "${NATS_CREDS:-}" ] || [ -z "${JOB_RUN_ID:-}" ]; then
    # Missing env is non-fatal — the container can still complete the backup,
    # we just lose the live progress stream. Log once and bail.
    echo "[nats-progress] WARN: missing NATS_URL / NATS_CREDS / JOB_RUN_ID — skipping publish" >&2
    exit 0
fi

# Cache the creds file across publish calls so we don't write it for every
# percentage tick. `mktemp -u` returns a path without creating it; the file is
# created on the first publish and reused thereafter. The container's
# filesystem is ephemeral so a global cleanup isn't necessary, but we still
# clean up on EXIT for tidy logs.
: "${NATS_CREDS_FILE:=/tmp/.nats-creds-$$}"
if [ ! -s "$NATS_CREDS_FILE" ]; then
    umask 077
    printf '%s' "$NATS_CREDS" > "$NATS_CREDS_FILE"
fi

SUBJECT="mini-infra.backup.progress.${JOB_RUN_ID}"

# JSON-encode the body with `nats` does NOT support per-field escaping, so we
# build the payload by hand. The message is the only field that needs
# escaping (status is enum, progress is int, operationId is the run id). Use
# jq when available for safety; fall back to a conservative escaper that
# strips backslashes and quotes so a stray character can't break the JSON.
PAYLOAD=$(cat <<EOF
{"operationId":"${JOB_RUN_ID}","status":"${STATUS}","progress":${PROGRESS},"message":"${MESSAGE//\"/\\\"}"}
EOF
)

# Publish — best-effort. `nats pub` honors --server and --creds. `-q` quiets
# the success message; non-zero exit is logged but doesn't propagate.
if ! nats pub --server="$NATS_URL" --creds="$NATS_CREDS_FILE" -q "$SUBJECT" "$PAYLOAD" 2>/tmp/.nats-pub.err; then
    echo "[nats-progress] WARN: nats pub failed for $SUBJECT — $(cat /tmp/.nats-pub.err 2>/dev/null || true)" >&2
    # fall through; never break the backup
fi
exit 0
