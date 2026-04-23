#!/bin/bash
# Mini Infra Worktree Seeder
#
# Drives the running app via its REST API to skip onboarding:
#   1. Create the first admin user via POST /auth/setup
#   2. Exchange admin credentials for a full-admin API key via
#      POST /api/dev/issue-api-key (requires ENABLE_DEV_API_KEY_ENDPOINT=true)
#   3. Complete the setup wizard (docker host) via POST /auth/setup/complete
#   3b. Upsert docker_host_ip system setting (needed for application DNS records)
#   4. Upsert Azure / Cloudflare / GitHub credentials from ~/.mini-infra/dev.env
#   5. Create a local environment
#   6. Instantiate the built-in HAProxy stack template into the local env
#   7. Mark onboarding complete
#
# Each step is idempotent-ish: already-configured state is logged and skipped,
# but the script doesn't go out of its way to back out partial state — if a
# step fails mid-way, fix the env file and re-run.
#
# Invoked by worktree_start.sh once the app is healthy. Expects UI_PORT and
# DEV_ENV_FILE to be set in the environment.

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
NC='\033[0m'
ts()    { date '+%H:%M:%S'; }
info()  { echo -e "${CYAN}[$(ts)] ▸ $1${NC}"; }
ok()    { echo -e "${GREEN}[$(ts)] ✓ $1${NC}"; }
skip()  { echo -e "${YELLOW}[$(ts)] • $1${NC}"; }
fail()  { echo -e "${RED}[$(ts)] ✗ $1${NC}"; }
debug() { [ "${SEED_DEBUG:-0}" = "1" ] && echo -e "${GRAY}[$(ts)] DBG $1${NC}" || true; }

: "${UI_PORT:?UI_PORT must be set}"
: "${DEV_ENV_FILE:?DEV_ENV_FILE must be set}"

if [ ! -f "$DEV_ENV_FILE" ]; then
    fail "Env file not found: $DEV_ENV_FILE"
    exit 1
fi

# shellcheck disable=SC1090
set -a; source "$DEV_ENV_FILE"; set +a

: "${ADMIN_EMAIL:?ADMIN_EMAIL must be set in dev.env}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD must be set in dev.env}"
: "${ADMIN_DISPLAY_NAME:=Admin}"

BASE_URL="http://localhost:$UI_PORT"

# Shared buffers for API call response body and curl stderr.
# Can't be created inside api() because $(...) runs in a subshell.
RESP_FILE="$(mktemp)"
CURL_ERR_FILE="$(mktemp)"
trap 'rm -f "$RESP_FILE" "$CURL_ERR_FILE"' EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
# Prints the HTTP status to stdout; writes the response body to $RESP_FILE.
# On curl network failure (status "000"), RESP_FILE contains the curl error.
api() {
    local method="$1" path="$2" body="${3-}"
    : > "$RESP_FILE"
    : > "$CURL_ERR_FILE"
    local curl_args=(-sS -o "$RESP_FILE" -w "%{http_code}" -X "$method" \
        -H "Content-Type: application/json" "${BASE_URL}${path}")
    if [ -n "${API_KEY:-}" ]; then
        curl_args+=(-H "Authorization: Bearer ${API_KEY}")
    fi
    if [ -n "$body" ]; then
        curl_args+=(-d "$body")
    fi
    debug "$method ${BASE_URL}${path}"
    local http_code
    http_code=$(curl "${curl_args[@]}" 2>"$CURL_ERR_FILE") || true
    if [ -z "$http_code" ]; then
        # curl network failure — stash its stderr in RESP_FILE so callers surface it
        cat "$CURL_ERR_FILE" > "$RESP_FILE"
        debug "curl failed: $(cat "$CURL_ERR_FILE")"
        echo "000"
        return
    fi
    debug "→ $http_code"
    echo "$http_code"
}

# Polls GET /health until the app responds 200 or timeout expires.
wait_for_healthy() {
    local max="${1:-30}" label="${2:-app}"
    info "Waiting for $label to become healthy (up to ${max}s)..."
    for i in $(seq 1 "$max"); do
        if curl -sf "$BASE_URL/health" >/dev/null 2>&1; then
            ok "$label is healthy"
            return 0
        fi
        debug "health check attempt $i/$max failed"
        sleep 1
    done
    fail "$label did not become healthy within ${max}s"
    return 1
}

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'; }

# ---------------------------------------------------------------------------
# 1. Create admin user (idempotent: /auth/setup returns 403 if already done)
# ---------------------------------------------------------------------------
info "Checking setup status"
status=$(api GET /auth/setup-status)
if [ "$status" != "200" ]; then
    fail "setup-status returned $status: $(cat "$RESP_FILE")"
    exit 1
fi
setup_complete=$(python3 -c "import json,sys; print(json.load(open('$RESP_FILE')).get('setupComplete', False))")
has_users=$(python3 -c "import json,sys; print(json.load(open('$RESP_FILE')).get('hasUsers', False))")

if [ "$has_users" = "True" ]; then
    skip "Admin user already exists"
else
    info "Creating admin user $ADMIN_EMAIL"
    body=$(python3 -c "
import json, os
print(json.dumps({
    'email': os.environ['ADMIN_EMAIL'],
    'displayName': os.environ['ADMIN_DISPLAY_NAME'],
    'password': os.environ['ADMIN_PASSWORD'],
}))")
    status=$(api POST /auth/setup "$body")
    if [ "$status" != "201" ]; then
        fail "POST /auth/setup returned $status: $(cat "$RESP_FILE")"
        exit 1
    fi
    ok "Admin user created"
fi

# ---------------------------------------------------------------------------
# 2. Issue a full-admin API key
# ---------------------------------------------------------------------------
info "Issuing dev API key"
body=$(python3 -c "
import json, os
print(json.dumps({
    'email': os.environ['ADMIN_EMAIL'],
    'password': os.environ['ADMIN_PASSWORD'],
    'name': 'worktree-seeder',
}))")
status=$(api POST /api/dev/issue-api-key "$body")
if [ "$status" != "201" ]; then
    fail "issue-api-key returned $status: $(cat "$RESP_FILE")"
    fail "Is ENABLE_DEV_API_KEY_ENDPOINT=true set on the container?"
    exit 1
fi
API_KEY=$(python3 -c "import json; print(json.load(open('$RESP_FILE'))['apiKey'])")
export API_KEY
ok "API key obtained"

# ---------------------------------------------------------------------------
# 3. Complete setup wizard (docker host)
# ---------------------------------------------------------------------------
if [ "$setup_complete" = "True" ]; then
    skip "Setup wizard already completed"
else
    info "Completing setup wizard"
    # /var/run/docker.sock inside the container is bind-mounted to the Colima
    # profile's socket on the host. That's the only docker socket the container
    # can reach, so it's the correct value to save here.
    body='{"dockerHost":"unix:///var/run/docker.sock"}'
    status=$(api POST /auth/setup/complete "$body")
    if [ "$status" != "200" ] && [ "$status" != "201" ]; then
        fail "setup/complete returned $status: $(cat "$RESP_FILE")"
        exit 1
    fi
    ok "Setup wizard completed"
    # The server restarts after setup/complete to apply Docker host config.
    # Wait for it to recover before continuing or subsequent API calls will fail.
    wait_for_healthy 30 "app after setup"
fi

# ---------------------------------------------------------------------------
# 3b. Set Docker host IP (always runs — idempotent upsert via settings API).
# Used as the DNS A-record target when deploying stateless web apps. Required
# for POST /api/stack-templates/:id/instantiate to succeed.
# ---------------------------------------------------------------------------
info "Setting Docker host IP"
# Prefer explicit value from dev.env; fall back to auto-detecting the primary
# outbound interface IP via a UDP probe (never actually sends a packet).
if [ -z "${DOCKER_HOST_IP:-}" ]; then
    DOCKER_HOST_IP=$(python3 -c "
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(('8.8.8.8', 80))
    print(s.getsockname()[0])
    s.close()
except Exception:
    print('')
" 2>/dev/null || echo "")
fi

if [ -z "$DOCKER_HOST_IP" ]; then
    skip "Could not detect Docker host IP — set DOCKER_HOST_IP in dev.env to enable application DNS records"
else
    # Check whether the setting already exists (filter by category + key + isActive).
    status=$(api GET "/api/settings?category=system&key=docker_host_ip&isActive=true")
    existing_setting_id=""
    existing_value=""
    if [ "$status" = "200" ]; then
        existing_setting_id=$(RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
items = d.get('data') if isinstance(d, dict) else d
for s in (items or []):
    if s.get('category') == 'system' and s.get('key') == 'docker_host_ip':
        print(s.get('id', ''))
        break
" 2>/dev/null || echo "")
        existing_value=$(RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
items = d.get('data') if isinstance(d, dict) else d
for s in (items or []):
    if s.get('category') == 'system' and s.get('key') == 'docker_host_ip':
        print(s.get('value', ''))
        break
" 2>/dev/null || echo "")
    fi

    if [ -n "$existing_setting_id" ] && [ "$existing_value" = "$DOCKER_HOST_IP" ]; then
        skip "Docker host IP already set ($DOCKER_HOST_IP)"
    elif [ -n "$existing_setting_id" ]; then
        body=$(DOCKER_HOST_IP="$DOCKER_HOST_IP" python3 -c "
import json, os
print(json.dumps({'value': os.environ['DOCKER_HOST_IP']}))")
        status=$(api PUT "/api/settings/$existing_setting_id" "$body")
        if [ "$status" = "200" ]; then
            ok "Docker host IP updated ($DOCKER_HOST_IP)"
        else
            skip "Docker host IP update returned $status (non-fatal): $(cat "$RESP_FILE")"
        fi
    else
        body=$(DOCKER_HOST_IP="$DOCKER_HOST_IP" python3 -c "
import json, os
print(json.dumps({
    'category': 'system',
    'key': 'docker_host_ip',
    'value': os.environ['DOCKER_HOST_IP'],
    'isEncrypted': False,
}))")
        status=$(api POST "/api/settings" "$body")
        if [ "$status" = "201" ] || [ "$status" = "200" ]; then
            ok "Docker host IP set ($DOCKER_HOST_IP)"
        else
            skip "Docker host IP create returned $status (non-fatal): $(cat "$RESP_FILE")"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# 4. Service credentials (best-effort: missing env vars skip the step)
# ---------------------------------------------------------------------------
if [ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ]; then
    info "Configuring Azure Storage"
    body=$(python3 -c "
import json, os
print(json.dumps({'connectionString': os.environ['AZURE_STORAGE_CONNECTION_STRING']}))")
    status=$(api PUT /api/settings/azure "$body")
    if [ "$status" = "200" ] || [ "$status" = "201" ]; then
        ok "Azure configured"
        info "Validating Azure connectivity"
        status=$(api POST /api/settings/validate/azure "{}")
        if [ "$status" = "200" ] || [ "$status" = "201" ]; then
            ok "Azure connectivity verified"
        else
            skip "Azure validation returned $status (non-fatal): $(cat "$RESP_FILE")"
        fi
    else
        fail "Azure PUT returned $status: $(cat "$RESP_FILE")"
    fi
else
    skip "AZURE_STORAGE_CONNECTION_STRING not set — skipping"
fi

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    info "Configuring Cloudflare"
    body=$(python3 -c "
import json, os
print(json.dumps({
    'api_token': os.environ['CLOUDFLARE_API_TOKEN'],
    'account_id': os.environ['CLOUDFLARE_ACCOUNT_ID'],
}))")
    status=$(api POST /api/settings/cloudflare "$body")
    if [ "$status" = "200" ] || [ "$status" = "201" ]; then
        ok "Cloudflare configured"
        info "Validating Cloudflare connectivity"
        status=$(api POST /api/settings/validate/cloudflare "{}")
        if [ "$status" = "200" ] || [ "$status" = "201" ]; then
            ok "Cloudflare connectivity verified"
        else
            skip "Cloudflare validation returned $status (non-fatal): $(cat "$RESP_FILE")"
        fi
    else
        fail "Cloudflare POST returned $status: $(cat "$RESP_FILE")"
    fi
else
    skip "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — skipping"
fi

if [ -n "${GITHUB_TOKEN:-}" ]; then
    info "Configuring GitHub"
    body=$(python3 -c "
import json, os
print(json.dumps({'token': os.environ['GITHUB_TOKEN']}))")
    status=$(api PUT /api/settings/github "$body")
    if [ "$status" = "200" ] || [ "$status" = "201" ]; then
        ok "GitHub configured"
        info "Validating GitHub connectivity"
        status=$(api POST /api/settings/validate/github-app "{}")
        if [ "$status" = "200" ] || [ "$status" = "201" ]; then
            ok "GitHub connectivity verified"
        else
            skip "GitHub validation returned $status (non-fatal): $(cat "$RESP_FILE")"
        fi
    else
        # GitHub settings route shape may differ — surface the response so the
        # user can adjust the payload without guessing.
        skip "GitHub PUT returned $status (likely a payload-shape mismatch): $(cat "$RESP_FILE")"
    fi
else
    skip "GITHUB_TOKEN not set — skipping"
fi

# ---------------------------------------------------------------------------
# 5. Create the local environment
# ---------------------------------------------------------------------------
info "Creating local environment"
ENV_NAME="${LOCAL_ENV_NAME:-local}"
status=$(api GET "/api/environments")
LOCAL_ENV_ID=""
if [ "$status" = "200" ]; then
    LOCAL_ENV_ID=$(python3 -c "
import json, sys
envs = json.load(open('$RESP_FILE'))
if isinstance(envs, dict):
    envs = envs.get('data') or envs.get('environments') or []
for e in envs:
    if e.get('networkType') == 'local':
        print(e.get('id', ''))
        break
")
fi

if [ -n "$LOCAL_ENV_ID" ]; then
    skip "Local environment already exists (id=$LOCAL_ENV_ID)"
else
    body=$(python3 -c "
import json, os
print(json.dumps({
    'name': os.environ.get('LOCAL_ENV_NAME', 'local'),
    'description': 'Dev local environment (seeded)',
    'type': 'nonproduction',
    'networkType': 'local',
}))")
    status=$(api POST /api/environments "$body")
    if [ "$status" != "201" ]; then
        fail "POST /api/environments returned $status: $(cat "$RESP_FILE")"
        exit 1
    fi
    LOCAL_ENV_ID=$(python3 -c "import json; print(json.load(open('$RESP_FILE')).get('id',''))")
    ok "Local environment created (id=$LOCAL_ENV_ID)"
fi

# ---------------------------------------------------------------------------
# 6. Ensure HAProxy stack exists in the local env, then apply it.
# Re-runs are idempotent: we look up an existing haproxy-local stack by name
# before instantiating a fresh one. The /:templateId/instantiate endpoint does
# not dedupe on its own.
# ---------------------------------------------------------------------------
STACK_NAME="haproxy-local"

info "Looking for existing $STACK_NAME stack in local env"
HAPROXY_STACK_ID=""
status=$(api GET "/api/stacks?environmentId=$LOCAL_ENV_ID")
if [ "$status" = "200" ]; then
    HAPROXY_STACK_ID=$(STACK_NAME="$STACK_NAME" RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
stacks = d.get('data') if isinstance(d, dict) else d
for s in stacks or []:
    if s.get('name') == os.environ['STACK_NAME']:
        print(s.get('id', ''))
        break
")
fi

if [ -n "$HAPROXY_STACK_ID" ]; then
    skip "HAProxy stack already exists (id=$HAPROXY_STACK_ID)"
else
    info "Locating HAProxy stack template"
    status=$(api GET "/api/stack-templates")
    HAPROXY_TPL_ID=""
    if [ "$status" = "200" ]; then
        HAPROXY_TPL_ID=$(RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
items = d if isinstance(d, list) else (d.get('data') or d.get('templates') or [])
for t in items:
    if 'haproxy' in (t.get('name') or '').lower():
        print(t.get('id', ''))
        break
")
    fi

    if [ -z "$HAPROXY_TPL_ID" ]; then
        skip "HAProxy template not found — skipping HAProxy setup"
    else
        body=$(STACK_NAME="$STACK_NAME" LOCAL_ENV_ID="$LOCAL_ENV_ID" python3 -c "
import json, os
print(json.dumps({
    'environmentId': os.environ['LOCAL_ENV_ID'],
    'name': os.environ['STACK_NAME'],
}))")
        status=$(api POST "/api/stack-templates/$HAPROXY_TPL_ID/instantiate" "$body")
        if [ "$status" != "201" ]; then
            fail "HAProxy instantiate returned $status: $(cat "$RESP_FILE")"
        else
            HAPROXY_STACK_ID=$(RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
s = d.get('data') if isinstance(d, dict) else d
print((s or {}).get('id', ''))
")
            ok "HAProxy stack created (id=$HAPROXY_STACK_ID)"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# 7. Apply the HAProxy stack so containers are actually running.
# Apply is fire-and-forget; we poll status until Synced/Error or timeout.
# ---------------------------------------------------------------------------
if [ -n "$HAPROXY_STACK_ID" ]; then
    # Snapshot both status and lastAppliedAt pre-apply. The status field may
    # still read "error" (or whatever) from a prior run until the reconciler
    # finishes this one, so we use lastAppliedAt as the authoritative
    # "reconciler completed a new run" signal.
    current_status=""
    prev_last_applied=""
    status=$(api GET "/api/stacks/$HAPROXY_STACK_ID")
    if [ "$status" = "200" ]; then
        current_status=$(RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
s = (d.get('data') if isinstance(d, dict) else d) or {}
print(s.get('status','') or '')
")
        prev_last_applied=$(RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
s = (d.get('data') if isinstance(d, dict) else d) or {}
print(s.get('lastAppliedAt','') or '')
")
    fi

    current_lower=$(echo "$current_status" | tr '[:upper:]' '[:lower:]')
    if [ "$current_lower" = "synced" ]; then
        skip "HAProxy stack is already Synced — skipping apply"
    else
        info "Applying HAProxy stack (current status: ${current_status:-unknown})"
        status=$(api POST "/api/stacks/$HAPROXY_STACK_ID/apply" "{}")
        if [ "$status" != "200" ] && [ "$status" != "202" ]; then
            fail "Apply returned $status: $(cat "$RESP_FILE")"
        else
            info "Apply started — polling for completion (timeout 120s)"
            polled_status=""
            for i in $(seq 1 40); do
                sleep 3
                status=$(api GET "/api/stacks/$HAPROXY_STACK_ID")
                if [ "$status" != "200" ]; then
                    continue
                fi
                polled_status=$(RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
s = (d.get('data') if isinstance(d, dict) else d) or {}
print(s.get('status','') or '')
")
                polled_last_applied=$(RESP_FILE="$RESP_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['RESP_FILE']))
s = (d.get('data') if isinstance(d, dict) else d) or {}
print(s.get('lastAppliedAt','') or '')
")
                # Only treat a terminal status as meaningful once lastAppliedAt
                # has advanced — otherwise we'd accept the pre-apply value.
                if [ "$polled_last_applied" = "$prev_last_applied" ]; then
                    continue
                fi
                polled_lower=$(echo "$polled_status" | tr '[:upper:]' '[:lower:]')
                case "$polled_lower" in
                    synced)
                        ok "HAProxy stack is Synced"
                        break
                        ;;
                    error)
                        fail "HAProxy stack apply failed (status=error)"
                        break
                        ;;
                esac
                if [ "$i" -eq 40 ]; then
                    skip "Timed out waiting for HAProxy to sync (last status: ${polled_status:-unknown})"
                fi
            done
        fi
    fi
fi

# ---------------------------------------------------------------------------
# 7. Mark onboarding complete
# ---------------------------------------------------------------------------
info "Marking onboarding complete"
status=$(api POST /api/onboarding/complete "{}")
if [ "$status" = "200" ] || [ "$status" = "201" ] || [ "$status" = "204" ]; then
    ok "Onboarding marked complete"
else
    skip "onboarding/complete returned $status (may already be complete): $(cat "$RESP_FILE")"
fi

# ---------------------------------------------------------------------------
# 8. Emit environment-details.xml at the project root.
# Only written when DETAILS_FILE is provided (by worktree_start.sh). Captures
# the current state of the worktree instance so follow-up tooling — or a human
# — can see everything in one place without going hunting across shells.
# ---------------------------------------------------------------------------
if [ -n "${DETAILS_FILE:-}" ]; then
    info "Writing $DETAILS_FILE"
    # Collect fresh state from the API so whatever the seeder skipped or
    # couldn't change is still reflected accurately.
    status=$(api GET "/api/environments")
    envs_json="${RESP_FILE}.envs"; cp "$RESP_FILE" "$envs_json"
    status=$(api GET "/api/stacks?environmentId=$LOCAL_ENV_ID")
    stacks_json="${RESP_FILE}.stacks"; cp "$RESP_FILE" "$stacks_json"

    DETAILS_FILE="$DETAILS_FILE" \
    PROFILE="${PROFILE:-}" \
    PROJECT_ROOT="${PROJECT_ROOT:-}" \
    UI_PORT="$UI_PORT" \
    REGISTRY_PORT="${REGISTRY_PORT:-}" \
    DOCKER_HOST="${DOCKER_HOST:-}" \
    COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}" \
    AGENT_SIDECAR_IMAGE_TAG="${AGENT_SIDECAR_IMAGE_TAG:-}" \
    ADMIN_EMAIL="$ADMIN_EMAIL" \
    API_KEY="${API_KEY:-}" \
    LOCAL_ENV_ID="$LOCAL_ENV_ID" \
    ENVS_JSON="$envs_json" \
    STACKS_JSON="$stacks_json" \
    AZURE_SET="$([ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ] && echo true || echo false)" \
    CLOUDFLARE_SET="$([ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && echo true || echo false)" \
    GITHUB_SET="$([ -n "${GITHUB_TOKEN:-}" ] && echo true || echo false)" \
    python3 - <<'PY'
import json, os
from datetime import datetime, timezone
from xml.sax.saxutils import escape

def t(v):
    return escape(v or '')

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

envs = load(os.environ['ENVS_JSON']) or []
if isinstance(envs, dict):
    envs = envs.get('data') or envs.get('environments') or []
local_env = next((e for e in envs if e.get('id') == os.environ['LOCAL_ENV_ID']), None)

stacks_raw = load(os.environ['STACKS_JSON']) or []
if isinstance(stacks_raw, dict):
    stacks_raw = stacks_raw.get('data') or []

stacks_xml = []
for s in stacks_raw:
    stacks_xml.append(
        '    <stack>\n'
        f'      <id>{t(s.get("id"))}</id>\n'
        f'      <name>{t(s.get("name"))}</name>\n'
        f'      <status>{t(s.get("status"))}</status>\n'
        f'      <lastAppliedAt>{t(s.get("lastAppliedAt"))}</lastAppliedAt>\n'
        '    </stack>'
    )
stacks_block = '\n'.join(stacks_xml) if stacks_xml else ''

local_env_block = ''
if local_env:
    local_env_block = (
        '  <localEnvironment>\n'
        f'    <id>{t(local_env.get("id"))}</id>\n'
        f'    <name>{t(local_env.get("name"))}</name>\n'
        f'    <type>{t(local_env.get("type"))}</type>\n'
        f'    <networkType>{t(local_env.get("networkType"))}</networkType>\n'
        '  </localEnvironment>'
    )

xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<environment>
  <generated>{datetime.now(timezone.utc).isoformat(timespec='seconds')}</generated>
  <seeded>true</seeded>
  <worktree>
    <profile>{t(os.environ['PROFILE'])}</profile>
    <path>{t(os.environ['PROJECT_ROOT'])}</path>
    <dockerHost>{t(os.environ['DOCKER_HOST'])}</dockerHost>
    <composeProject>{t(os.environ['COMPOSE_PROJECT_NAME'])}</composeProject>
  </worktree>
  <endpoints>
    <ui>http://localhost:{t(os.environ['UI_PORT'])}</ui>
    <registry>localhost:{t(os.environ['REGISTRY_PORT'])}</registry>
  </endpoints>
  <images>
    <agentSidecar>{t(os.environ['AGENT_SIDECAR_IMAGE_TAG'])}</agentSidecar>
  </images>
  <admin>
    <email>{t(os.environ['ADMIN_EMAIL'])}</email>
    <password>{t(os.environ['ADMIN_PASSWORD'])}</password>
    <apiKey>{t(os.environ['API_KEY'])}</apiKey>
  </admin>
  <connectedServices>
    <azure configured="{os.environ['AZURE_SET']}"/>
    <cloudflare configured="{os.environ['CLOUDFLARE_SET']}"/>
    <github configured="{os.environ['GITHUB_SET']}"/>
  </connectedServices>
{local_env_block}
  <stacks>
{stacks_block}
  </stacks>
</environment>
"""
with open(os.environ['DETAILS_FILE'], 'w') as f:
    f.write(xml)
PY
    rm -f "$envs_json" "$stacks_json"
    ok "Wrote $DETAILS_FILE"
fi

echo ""
ok "Seeder finished"
