#!/bin/bash
# Mini Infra Per-Worktree Development Startup (Bash)
#
# Runs one fully isolated Mini Infra instance per worktree by giving each a
# dedicated Colima VM (its own Docker daemon) and a namespaced Compose project.
# Ports are allocated from ~/.mini-infra/worktrees.json so re-runs are stable.
#
# Usage: ./worktree_start.sh [--profile <name>] [--reset] [--skip-seed]
#
# After the app is healthy, the script runs worktree_seed.sh to POST /setup,
# issue an admin API key, and seed service configs + a local environment +
# HAProxy from values in ~/.mini-infra/dev.env.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.worktree.yaml"
SEED_SCRIPT="$SCRIPT_DIR/worktree_seed.sh"

# ---------------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------------
MINI_INFRA_HOME="${MINI_INFRA_HOME:-$HOME/.mini-infra}"
REGISTRY_FILE="$MINI_INFRA_HOME/worktrees.json"
DEV_ENV_FILE="$MINI_INFRA_HOME/dev.env"

UI_PORT_MIN=3100
UI_PORT_MAX=3199
REGISTRY_PORT_MIN=5100
REGISTRY_PORT_MAX=5199

COLIMA_CPUS=2
COLIMA_MEMORY=8

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m'

ts() { date '+%H:%M:%S'; }
log_info()  { echo -e "${CYAN}[$(ts)] $1${NC}"; }
log_ok()    { echo -e "${GREEN}[$(ts)] $1${NC}"; }
log_warn()  { echo -e "${YELLOW}[$(ts)] $1${NC}"; }
log_error() { echo -e "${RED}[$(ts)] $1${NC}"; }

# Minimal environment-details.xml used when the seeder doesn't run (skip-seed
# or missing dev.env). The seeder itself writes a richer version including the
# local environment / stack IDs / connected-service status.
write_minimal_environment_details() {
    local target="$1"
    PROFILE="$PROFILE" \
    PROJECT_ROOT="$PROJECT_ROOT" \
    UI_PORT="$UI_PORT" \
    REGISTRY_PORT="$REGISTRY_PORT" \
    DOCKER_HOST="$DOCKER_HOST" \
    DOCKER_SOCK_PATH="$DOCKER_SOCK_PATH" \
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    AGENT_SIDECAR_IMAGE_TAG="$AGENT_SIDECAR_IMAGE_TAG" \
    TARGET="$target" \
    python3 - <<'PY'
import os
from datetime import datetime, timezone
from xml.sax.saxutils import escape

def t(v):
    return escape(v or '')

xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<environment>
  <generated>{datetime.now(timezone.utc).isoformat(timespec='seconds')}</generated>
  <seeded>false</seeded>
  <worktree>
    <profile>{t(os.environ['PROFILE'])}</profile>
    <path>{t(os.environ['PROJECT_ROOT'])}</path>
    <dockerHost>{t(os.environ['DOCKER_HOST'])}</dockerHost>
    <dockerSocket>{t(os.environ.get('DOCKER_SOCK_PATH',''))}</dockerSocket>
    <composeProject>{t(os.environ['COMPOSE_PROJECT_NAME'])}</composeProject>
  </worktree>
  <endpoints>
    <ui>http://localhost:{t(os.environ['UI_PORT'])}</ui>
    <registry>localhost:{t(os.environ['REGISTRY_PORT'])}</registry>
  </endpoints>
  <images>
    <agentSidecar>{t(os.environ['AGENT_SIDECAR_IMAGE_TAG'])}</agentSidecar>
  </images>
</environment>
"""
with open(os.environ['TARGET'], 'w') as f:
    f.write(xml)
print(f"Wrote {os.environ['TARGET']}")
PY
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
PROFILE=""
RESET=false
SKIP_SEED=false
FORCE_SEED=false

while [ $# -gt 0 ]; do
    case "$1" in
        --profile) PROFILE="$2"; shift 2 ;;
        --reset) RESET=true; shift ;;
        --skip-seed) SKIP_SEED=true; shift ;;
        --seed) FORCE_SEED=true; shift ;;
        -h|--help)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        *) log_error "Unknown arg: $1"; exit 1 ;;
    esac
done

# Derive profile name from the worktree directory basename if not passed
if [ -z "$PROFILE" ]; then
    WORKTREE_DIR="$(cd "$PROJECT_ROOT" && pwd)"
    PROFILE="$(basename "$WORKTREE_DIR")"
fi
# Colima profile names must match [a-z0-9-]+; normalize liberally.
PROFILE="$(echo "$PROFILE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g; s/^-//; s/-$//')"
if [ -z "$PROFILE" ]; then
    log_error "Could not derive a valid profile name"
    exit 1
fi
log_info "Worktree profile: $PROFILE"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v colima >/dev/null 2>&1; then
    log_error "colima is not installed. Install with: brew install colima"
    exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
    log_error "docker CLI is not installed. Install with: brew install docker"
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    log_error "python3 is required for port allocation"
    exit 1
fi

mkdir -p "$MINI_INFRA_HOME"
[ -f "$REGISTRY_FILE" ] || echo '{"worktrees": {}}' > "$REGISTRY_FILE"

# ---------------------------------------------------------------------------
# Allocate ports (deterministic: same worktree always gets same ports)
# ---------------------------------------------------------------------------
PORTS_JSON=$(python3 - <<PY
import json, sys
reg_path = "$REGISTRY_FILE"
profile = "$PROFILE"
ui_min, ui_max = $UI_PORT_MIN, $UI_PORT_MAX
reg_min, reg_max = $REGISTRY_PORT_MIN, $REGISTRY_PORT_MAX

with open(reg_path) as f:
    reg = json.load(f)
wt = reg.setdefault("worktrees", {})

if profile in wt:
    entry = wt[profile]
else:
    used_ui = {w.get("ui_port") for w in wt.values()}
    used_reg = {w.get("registry_port") for w in wt.values()}
    ui = next((p for p in range(ui_min, ui_max + 1) if p not in used_ui), None)
    rg = next((p for p in range(reg_min, reg_max + 1) if p not in used_reg), None)
    if ui is None or rg is None:
        print("NO_PORTS", file=sys.stderr)
        sys.exit(1)
    entry = {"ui_port": ui, "registry_port": rg, "profile": profile}
    wt[profile] = entry
    with open(reg_path, "w") as f:
        json.dump(reg, f, indent=2, sort_keys=True)

print(f"{entry['ui_port']} {entry['registry_port']}")
PY
)
UI_PORT=$(echo "$PORTS_JSON" | awk '{print $1}')
REGISTRY_PORT=$(echo "$PORTS_JSON" | awk '{print $2}')
if [ -z "$UI_PORT" ] || [ -z "$REGISTRY_PORT" ]; then
    log_error "Port allocation failed. Check $REGISTRY_FILE."
    exit 1
fi
log_info "Ports: UI=$UI_PORT, registry=$REGISTRY_PORT"

# ---------------------------------------------------------------------------
# Ensure Colima profile is running
# ---------------------------------------------------------------------------
COLIMA_STATUS=$(colima status "$PROFILE" 2>&1 || true)
if ! echo "$COLIMA_STATUS" | grep -q "Running"; then
    log_info "Starting Colima profile '$PROFILE' (vz, ${COLIMA_CPUS} CPU, ${COLIMA_MEMORY}G RAM)..."
    # vz + virtiofs are substantially faster on Apple Silicon; fall back to qemu
    # if vz fails (Intel, older macOS).
    colima start "$PROFILE" \
        --cpu "$COLIMA_CPUS" \
        --memory "$COLIMA_MEMORY" \
        --vm-type vz \
        --mount-type virtiofs \
        2>/dev/null || colima start "$PROFILE" \
            --cpu "$COLIMA_CPUS" \
            --memory "$COLIMA_MEMORY"
    log_ok "Colima profile '$PROFILE' started"
else
    log_info "Colima profile '$PROFILE' already running"
fi

DOCKER_SOCK_PATH="$HOME/.colima/$PROFILE/docker.sock"
if [ ! -S "$DOCKER_SOCK_PATH" ]; then
    log_error "Expected Colima socket not found at $DOCKER_SOCK_PATH"
    exit 1
fi

export DOCKER_HOST="unix://$DOCKER_SOCK_PATH"
export COMPOSE_PROJECT_NAME="mini-infra-$PROFILE"
export UI_PORT
export REGISTRY_PORT
export AGENT_SIDECAR_IMAGE_TAG="localhost:$REGISTRY_PORT/mini-infra-agent-sidecar:latest"
export PROJECT_ROOT
export PROFILE

# ---------------------------------------------------------------------------
# Handle --reset: tear down containers and volumes for this profile
# ---------------------------------------------------------------------------
if [ "$RESET" = true ]; then
    log_warn "⚠  WARNING: This will destroy ALL data for profile '$PROFILE' including:"
    echo "  - The database (users, settings, configuration)"
    echo "  - All log files"
    echo "  - Registry images"
    echo ""
    read -r -p "Are you sure? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
    log_info "Stopping containers and removing volumes for $COMPOSE_PROJECT_NAME..."
    docker compose -f "$COMPOSE_FILE" down -v || true
    log_ok "Reset complete. Rebuilding..."
    echo ""
fi

# ---------------------------------------------------------------------------
# Bring up the registry first so we have somewhere to push the sidecar image
# ---------------------------------------------------------------------------
log_info "Ensuring local Docker registry is running..."
docker compose -f "$COMPOSE_FILE" up -d registry

for i in $(seq 1 15); do
    if curl -sf "http://localhost:$REGISTRY_PORT/v2/" >/dev/null 2>&1; then
        break
    fi
    if [ "$i" -eq 15 ]; then
        log_error "Local registry failed to become ready on port $REGISTRY_PORT after 15s"
        docker compose -f "$COMPOSE_FILE" logs --tail=30 registry || true
        exit 1
    fi
    sleep 1
done
log_ok "Local registry is ready at localhost:$REGISTRY_PORT"

# ---------------------------------------------------------------------------
# Pre-pull images the stack reconciler needs as ephemeral helpers. Fresh
# Colima daemons don't have these cached, and stack apply creates containers
# directly (no auto-pull), so the first apply of HAProxy etc. fails without
# this step.
# ---------------------------------------------------------------------------
log_info "Pre-pulling alpine:latest (used by stack reconciler for ephemeral helpers)..."
docker pull alpine:latest >/dev/null && log_ok "alpine:latest ready"

# ---------------------------------------------------------------------------
# Build + push the agent sidecar image
# ---------------------------------------------------------------------------
log_info "Building agent sidecar image..."
docker build -t "$AGENT_SIDECAR_IMAGE_TAG" \
    -f "$PROJECT_ROOT/agent-sidecar/Dockerfile" "$PROJECT_ROOT"

log_info "Pushing agent sidecar image to $AGENT_SIDECAR_IMAGE_TAG..."
docker push "$AGENT_SIDECAR_IMAGE_TAG"
log_ok "Agent sidecar image pushed"

# ---------------------------------------------------------------------------
# Capture any extra networks dynamically joined at runtime (e.g. via
# joinSelf resource outputs like the vault network) so they survive the
# container recreate that --build triggers.
# ---------------------------------------------------------------------------
MINI_INFRA_CONTAINER="${COMPOSE_PROJECT_NAME}-mini-infra-1"
EXTRA_NETWORKS=""
if docker inspect "$MINI_INFRA_CONTAINER" >/dev/null 2>&1; then
    COMPOSE_NETWORKS=$(docker compose -f "$COMPOSE_FILE" config --format json 2>/dev/null \
        | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
project = cfg.get('name', '')
nets = set(['default'])
for svc in cfg.get('services', {}).values():
    for net_name in svc.get('networks', {}).keys():
        nets.add(net_name)
for n in nets:
    print(f'{project}_{n}')
" 2>/dev/null)
    CURRENT_NETWORKS=$(docker inspect "$MINI_INFRA_CONTAINER" \
        --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null)
    for net in $CURRENT_NETWORKS; do
        is_compose=false
        for cn in $COMPOSE_NETWORKS; do
            [ "$net" = "$cn" ] && is_compose=true && break
        done
        [ "$is_compose" = false ] && EXTRA_NETWORKS="$EXTRA_NETWORKS $net"
    done
    [ -n "$EXTRA_NETWORKS" ] && log_info "Will restore extra networks after rebuild:$EXTRA_NETWORKS"
fi

# ---------------------------------------------------------------------------
# Build + start the full stack
# ---------------------------------------------------------------------------
log_info "Building and starting Mini Infra (project=$COMPOSE_PROJECT_NAME)..."
docker compose -f "$COMPOSE_FILE" up -d --build

# ---------------------------------------------------------------------------
# Restore extra networks stripped by the container recreate
# ---------------------------------------------------------------------------
if [ -n "$EXTRA_NETWORKS" ]; then
    log_info "Waiting for ${MINI_INFRA_CONTAINER} to start before restoring networks..."
    for i in $(seq 1 30); do
        STATUS=$(docker inspect "$MINI_INFRA_CONTAINER" --format '{{.State.Status}}' 2>/dev/null)
        [ "$STATUS" = "running" ] && break
        sleep 1
    done
    for net in $EXTRA_NETWORKS; do
        if docker network inspect "$net" >/dev/null 2>&1; then
            docker network connect "$net" "$MINI_INFRA_CONTAINER" 2>/dev/null \
                && log_ok "Rejoined network: $net" \
                || log_warn "Failed to rejoin network: $net (may already be connected)"
        else
            log_warn "Skipping network $net (no longer exists)"
        fi
    done
fi

# ---------------------------------------------------------------------------
# Wait for health, then seed
# ---------------------------------------------------------------------------
log_info "Waiting for Mini Infra to become healthy on port $UI_PORT..."
for i in $(seq 1 60); do
    if curl -sf "http://localhost:$UI_PORT/health" >/dev/null 2>&1; then
        break
    fi
    if [ "$i" -eq 60 ]; then
        log_error "Mini Infra did not become healthy within 60s"
        log_error "Last 100 lines of container logs:"
        docker compose -f "$COMPOSE_FILE" logs --tail=100 mini-infra || true
        exit 1
    fi
    [ $((i % 10)) -eq 0 ] && log_info "Still waiting... (${i}s elapsed)"
    sleep 1
done
log_ok "Mini Infra is healthy"

DETAILS_FILE="$PROJECT_ROOT/environment-details.xml"

# Detect whether this instance has already been seeded by checking the
# existing environment-details.xml. Skip the seeder on rebuilds unless
# --seed or --reset was passed — matching the behaviour of start.sh.
ALREADY_SEEDED=false
if [ -f "$DETAILS_FILE" ] && grep -q "<seeded>true</seeded>" "$DETAILS_FILE" 2>/dev/null; then
    ALREADY_SEEDED=true
fi

if [ "$SKIP_SEED" = true ]; then
    log_warn "Skipping seed step (--skip-seed)"
    write_minimal_environment_details "$DETAILS_FILE"
elif [ "$ALREADY_SEEDED" = true ] && [ "$FORCE_SEED" = false ] && [ "$RESET" = false ]; then
    log_info "Instance already seeded — skipping (pass --seed to re-run)"
elif [ ! -f "$DEV_ENV_FILE" ]; then
    log_warn "Skipping seed step — $DEV_ENV_FILE not found"
    log_warn "Copy $SCRIPT_DIR/dev.env.example to $DEV_ENV_FILE and fill in values."
    write_minimal_environment_details "$DETAILS_FILE"
else
    log_info "Running seeder..."
    UI_PORT="$UI_PORT" DEV_ENV_FILE="$DEV_ENV_FILE" DETAILS_FILE="$DETAILS_FILE" bash "$SEED_SCRIPT"
fi

echo ""
log_ok "Mini Infra dev instance for '$PROFILE' is up"
echo ""
echo "  URL:         http://localhost:$UI_PORT"
echo "  Registry:    localhost:$REGISTRY_PORT"
echo "  DOCKER_HOST: $DOCKER_HOST"
echo ""
echo "  Logs:   DOCKER_HOST=$DOCKER_HOST docker compose -f $COMPOSE_FILE -p $COMPOSE_PROJECT_NAME logs -f"
echo "  Stop:   DOCKER_HOST=$DOCKER_HOST docker compose -f $COMPOSE_FILE -p $COMPOSE_PROJECT_NAME down"
echo "  Re-seed: $0 --seed --profile $PROFILE"
echo "  Nuke:    $0 --reset --profile $PROFILE"
echo ""
